// `pr.attachments`: upload, read and discard private files.

import { PingRoomError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { requireNonEmpty } from '../internal/guards.js';
import type { Attachment, ZipManifest, UploadAttachmentInput } from '../types.js';
import { enc } from '../internal/request.js';

/** Server cap per uploaded file; a larger body is a 413 the server answers before reading it. */
const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

function attachmentByteLength(content: UploadAttachmentInput['content']): number {
  if (content instanceof Blob) return content.size;
  if (typeof content === 'string') return new TextEncoder().encode(content).byteLength;
  return content.byteLength;
}

/**
 * Private files that a Ping or Question can carry.
 *
 * Upload first, then pass the returned ids to `broadcast()` / `questions.ask()`
 * as `attachment_ids`. Bytes never travel over MCP or a JSON ping body. An
 * upload that is never attached expires on its own after 24 hours.
 * Each file must be 1 byte–5 MiB with an md/pdf/html/txt/jpg/jpeg/png/zip filename;
 * a Ping or Question accepts at most four ids.
 *
 * Uploading requires the bound account to hold Pro (the API answers 402
 * `pro_required` otherwise). Reading and deleting are not gated.
 */
export class AttachmentsApi {
  constructor(private readonly http: HttpClient) {}

  /** Upload one file and get back the id a send can claim. */
  upload(input: UploadAttachmentInput): Promise<Attachment> {
    requireNonEmpty(input.filename, 'filename');
    // The server answers an oversized body with 413 before reading it; refuse
    // locally so no bytes travel for a file that can never be accepted.
    if (attachmentByteLength(input.content) > ATTACHMENT_MAX_BYTES) {
      return Promise.reject(
        new PingRoomError('Attachments are at most 5 MiB each.', { code: 'attachment_too_large', status: 413 }),
      );
    }

    const body = new FormData();
    body.append('file', toAttachmentBlob(input), input.filename);

    return this.http
      .request<{ attachment: Attachment }>('POST', '/api/agent/attachments', {
        body,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      .then((res) => res.attachment);
  }

  /**
   * Raw bytes for an attachment this credential is allowed to see. Returns the
   * undecoded Response so a caller can stream it, or read text/arrayBuffer.
   */
  content(attachmentId: string, signal?: AbortSignal): Promise<Response> {
    requireNonEmpty(attachmentId, 'attachmentId');
    return this.http.raw('GET', `/api/agent/attachments/${enc(attachmentId)}/content`, {
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * The listing of a `.zip`'s contents, recorded when it was uploaded.
   *
   * Resolves null for a non-archive, and for an archive whose central
   * directory did not parse. Nothing decompresses the file to produce this, so
   * the declared sizes are what the archive claims, not verified output.
   */
  manifest(attachmentId: string, signal?: AbortSignal): Promise<ZipManifest | null> {
    requireNonEmpty(attachmentId, 'attachmentId');
    return this.http
      .request<{ manifest: ZipManifest | null }>(
        'GET',
        `/api/agent/attachments/${enc(attachmentId)}/manifest`,
        { ...(signal ? { signal } : {}) },
      )
      .then((res) => res.manifest ?? null);
  }

  /** Discard an upload that has not been attached to a ping yet. */
  delete(attachmentId: string): Promise<void> {
    requireNonEmpty(attachmentId, 'attachmentId');
    return this.http.request('DELETE', `/api/agent/attachments/${enc(attachmentId)}`);
  }
}

/** Normalise the three accepted content shapes into one multipart part. */
function toAttachmentBlob(input: UploadAttachmentInput): Blob {
  const type = input.contentType ?? '';
  if (input.content instanceof Blob) {
    return type ? new Blob([input.content], { type }) : input.content;
  }
  // Copy into a plain ArrayBuffer: a Uint8Array view may be a window onto a
  // larger (or SharedArrayBuffer-backed) buffer, which Blob would not accept.
  const parts: BlobPart[] =
    typeof input.content === 'string'
      ? [input.content]
      : [new Uint8Array(input.content).slice().buffer as ArrayBuffer];

  return new Blob(parts, type ? { type } : undefined);
}
