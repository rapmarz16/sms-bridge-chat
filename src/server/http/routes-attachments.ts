import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, unlink, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { SqliteStore } from "../db/store.js";
import type { AuthService } from "../services/auth-service.js";
import type { ChatService } from "../services/chat-service.js";
import {
  isAcceptedImageMimeType,
  normalizeUploadedImage,
  safeImageFilename
} from "../services/image-service.js";
import { HttpError, requireCsrf, requireMember } from "./guards.js";

function textField(fields: Record<string, unknown>, name: string): string | undefined {
  const value = (fields as Record<string, unknown>)[name];
  if (!value || Array.isArray(value) || typeof value !== "object" || !("type" in value) || value.type !== "field") {
    return undefined;
  }
  const fieldValue = (value as { value?: unknown }).value;
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  auth: AuthService,
  chat: ChatService,
  store: SqliteStore,
  config: AppConfig
): void {
  app.post("/api/messages/images", {
    bodyLimit: config.imageUploadMaxBytes + 64 * 1024,
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const member = requireMember(request, auth);
    requireCsrf(request, config);
    if (!request.isMultipart()) throw new HttpError("Expected a multipart image upload", 415, "MULTIPART_REQUIRED");

    const file = await request.file({
      limits: {
        files: 1,
        fields: 5,
        parts: 6,
        fieldSize: Math.max(16_384, config.messageMaxLength * 4),
        fileSize: config.imageUploadMaxBytes
      },
      throwFileSizeLimit: false
    });
    if (!file || file.fieldname !== "image") throw new HttpError("Choose one photo to attach", 400, "IMAGE_REQUIRED");
    if (!isAcceptedImageMimeType(file.mimetype)) {
      file.file.resume();
      throw new HttpError("Use a JPEG, PNG, WebP, or AVIF photo", 415, "IMAGE_TYPE_UNSUPPORTED");
    }

    const source = await file.toBuffer();
    if (file.file.truncated || source.length > config.imageUploadMaxBytes) {
      throw new HttpError(`Photo must be ${Math.floor(config.imageUploadMaxBytes / 1024 / 1024)} MB or smaller`, 413, "IMAGE_TOO_LARGE");
    }
    const input = z.object({
      body: z.string().max(config.messageMaxLength).default(""),
      replyToMessageId: z.string().uuid().optional()
    }).parse({
      body: textField(file.fields, "body") ?? "",
      replyToMessageId: textField(file.fields, "replyToMessageId") || undefined
    });

    let normalized: Buffer;
    try {
      normalized = await normalizeUploadedImage(source, {
        maxDimension: config.imageMaxDimension,
        quality: config.imageWebpQuality,
        maxOutputBytes: config.imageUploadMaxBytes
      });
    } catch {
      throw new HttpError("The selected file is not a supported, valid photo", 400, "IMAGE_INVALID");
    }

    const attachmentId = randomUUID();
    const storagePath = `${attachmentId}.webp`;
    const absolutePath = resolve(config.uploadsPath, storagePath);
    await writeFile(absolutePath, normalized, { flag: "wx", mode: 0o600 });
    try {
      const message = chat.sendAppMessage(member, {
        body: input.body,
        replyToMessageId: input.replyToMessageId,
        attachments: [{
          id: attachmentId,
          type: "IMAGE",
          storagePath,
          originalFilename: safeImageFilename(file.filename),
          mimeType: "image/webp",
          size: normalized.length
        }]
      });
      return reply.code(201).send({ message });
    } catch (error) {
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    }
  });

  app.get("/api/attachments/:attachmentId", async (request, reply) => {
    const member = requireMember(request, auth);
    const params = z.object({ attachmentId: z.string().uuid() }).parse(request.params);
    const attachment = store.getStoredAttachment(params.attachmentId);
    if (!attachment || attachment.deleted || !store.memberBelongsToGroup(member.id, attachment.groupId)) {
      throw new HttpError("Attachment not found", 404, "ATTACHMENT_NOT_FOUND");
    }

    const uploadsRoot = resolve(config.uploadsPath);
    const absolutePath = resolve(uploadsRoot, attachment.storagePath);
    if (!absolutePath.startsWith(`${uploadsRoot}${sep}`)) {
      throw new HttpError("Attachment not found", 404, "ATTACHMENT_NOT_FOUND");
    }
    const details = await stat(absolutePath).catch(() => undefined);
    if (!details?.isFile()) throw new HttpError("Attachment not found", 404, "ATTACHMENT_NOT_FOUND");

    reply.header("cache-control", "private, no-store");
    reply.header("content-disposition", "inline");
    reply.header("content-length", String(details.size));
    reply.type(attachment.mimeType);
    return reply.send(createReadStream(absolutePath));
  });
}
