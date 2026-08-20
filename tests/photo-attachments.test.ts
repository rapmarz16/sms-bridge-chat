import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, login, type TestContext } from "./helpers.js";

function multipartPayload(input: {
  fields?: Record<string, string>;
  file: Buffer;
  filename?: string;
  mimeType?: string;
}): { payload: Buffer; contentType: string } {
  const boundary = `----sms-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(input.fields ?? {})) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${input.filename ?? "photo.jpg"}"\r\n` +
    `Content-Type: ${input.mimeType ?? "image/jpeg"}\r\n\r\n`
  ));
  chunks.push(input.file);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

async function jpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 120, height: 80, channels: 3, background: { r: 35, g: 90, b: 160 } }
  }).jpeg({ quality: 90 }).toBuffer();
}

describe("private photo attachments", () => {
  let context: TestContext | undefined;
  afterEach(async () => context?.close());

  it("validates, converts, stores, and serves an authenticated in-app photo", async () => {
    context = await createTestContext();
    const auth = await login(context);
    const upload = multipartPayload({
      fields: { body: "Family photo" },
      file: await jpeg(),
      filename: "../summer-photo.jpg"
    });
    const response = await context.built.app.inject({
      method: "POST",
      url: "/api/messages/images",
      headers: {
        cookie: auth.cookie,
        "x-csrf-token": auth.csrf,
        "content-type": upload.contentType
      },
      payload: upload.payload
    });

    expect(response.statusCode).toBe(201);
    const message = response.json().message;
    expect(message).toMatchObject({ body: "Family photo", attachments: [{ mimeType: "image/webp" }] });
    expect(message.attachments[0].originalFilename).toBe("summer-photo.jpg");
    expect(existsSync(join(context.config.uploadsPath, `${message.attachments[0].id}.webp`))).toBe(true);

    const anonymous = await context.built.app.inject({ method: "GET", url: message.attachments[0].url });
    expect(anonymous.statusCode).toBe(401);
    const downloaded = await context.built.app.inject({
      method: "GET",
      url: message.attachments[0].url,
      headers: { cookie: auth.cookie }
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["content-type"]).toContain("image/webp");
    expect(downloaded.headers["cache-control"]).toBe("private, no-store");
    expect(downloaded.rawPayload.subarray(0, 4).toString()).toBe("RIFF");
  });

  it("rejects missing CSRF, unsupported content, corrupt files, and oversized uploads", async () => {
    context = await createTestContext({ IMAGE_UPLOAD_MAX_BYTES: "65536" });
    const auth = await login(context);
    const valid = multipartPayload({ file: await jpeg() });
    const noCsrf = await context.built.app.inject({
      method: "POST",
      url: "/api/messages/images",
      headers: { cookie: auth.cookie, "content-type": valid.contentType },
      payload: valid.payload
    });
    expect(noCsrf.statusCode).toBe(403);

    const unsupported = multipartPayload({ file: Buffer.from("hello"), mimeType: "image/gif" });
    const unsupportedResponse = await context.built.app.inject({
      method: "POST",
      url: "/api/messages/images",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": unsupported.contentType },
      payload: unsupported.payload
    });
    expect(unsupportedResponse.statusCode).toBe(415);

    const corrupt = multipartPayload({ file: Buffer.from("not really a jpeg") });
    const corruptResponse = await context.built.app.inject({
      method: "POST",
      url: "/api/messages/images",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": corrupt.contentType },
      payload: corrupt.payload
    });
    expect(corruptResponse.statusCode).toBe(400);
    expect(corruptResponse.json().error).toBe("IMAGE_INVALID");

    const tooLarge = multipartPayload({ file: Buffer.alloc(70_000, 1) });
    const tooLargeResponse = await context.built.app.inject({
      method: "POST",
      url: "/api/messages/images",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": tooLarge.contentType },
      payload: tooLarge.payload
    });
    expect(tooLargeResponse.statusCode).toBe(413);
    expect(tooLargeResponse.json().error).toBe("IMAGE_TOO_LARGE");
  });

  it("sends SMS members a private-app photo marker without exposing a public media URL", async () => {
    context = await createTestContext({
      SMS_ENABLED: "true",
      VOIPMS_API_USERNAME: "test-user",
      VOIPMS_API_PASSWORD: "test-password",
      VOIPMS_SENDSMS_PARAMS_VERIFIED: "true"
    });
    const group = context.built.store.getDefaultGroup();
    context.built.store.createMember({
      groupId: group.id,
      displayName: "David",
      phoneNumberE164: "+14165550991",
      role: "MEMBER",
      deliveryMode: "SMS"
    });
    const auth = await login(context);
    const upload = multipartPayload({ file: await jpeg() });
    const response = await context.built.app.inject({
      method: "POST",
      url: "/api/messages/images",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": upload.contentType },
      payload: upload.payload
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().message.body).toBe("");

    await context.built.worker.drainOnce();
    expect(context.provider.sent).toHaveLength(1);
    expect(context.provider.sent[0].text).toContain("[Photo — view in app]");
    expect(context.provider.sent[0].text).not.toContain("/api/attachments/");
  });

  it("keeps a deletion tombstone and stops serving its photo", async () => {
    context = await createTestContext();
    const auth = await login(context);
    const upload = multipartPayload({ file: await jpeg() });
    const created = await context.built.app.inject({
      method: "POST",
      url: "/api/messages/images",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": upload.contentType },
      payload: upload.payload
    });
    const message = created.json().message;
    const deleted = await context.built.app.inject({
      method: "DELETE",
      url: `/api/messages/${message.id}`,
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf }
    });
    expect(deleted.statusCode).toBe(200);

    const attachment = await context.built.app.inject({
      method: "GET",
      url: message.attachments[0].url,
      headers: { cookie: auth.cookie }
    });
    expect(attachment.statusCode).toBe(404);
    expect(context.built.store.listMessages(context.built.store.getDefaultGroup().id, { limit: 10 }))
      .toEqual([expect.objectContaining({ id: message.id, body: "Message removed", attachments: [] })]);
  });
});
