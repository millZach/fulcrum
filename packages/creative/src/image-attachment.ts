import {
  IMAGE_ATTACHMENT_DATA_URL_PATTERN,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENTS,
  type ArtifactRef,
} from "@fulcrum/domain";
import type { VisionFrameInput } from "@fulcrum/execution";
import type { ProjectRepository } from "@fulcrum/project";
import sharp from "sharp";

/**
 * Images a user pastes into a free-text box.
 *
 * Three rules hold this together:
 *
 *  - Everything is re-encoded to PNG on the way in. The clipboard hands over
 *    PNG, JPEG or WebP depending on where the copy came from, but the vision
 *    seam downstream is PNG-only (`VisionFrameInput.mediaType`, and the Codex
 *    CLI path that writes each frame to `frame-NN.png`). Normalizing once at
 *    ingest means no later step has to care.
 *  - The stored bytes are the attachment's identity. `putArtifact` is
 *    content-addressed, so the same screenshot pasted into two answers is one
 *    file and one sha256, and nothing per-run leaks into what gets hashed.
 *  - An id from the browser is a claim, not a fact. It is always resolved back
 *    through the owning project before it becomes an `ArtifactRef`.
 */
export const MAX_IMAGE_ATTACHMENT_PIXELS = 4096;

const dataUrlBytes = (dataUrl: string): Buffer => {
  if (!IMAGE_ATTACHMENT_DATA_URL_PATTERN.test(dataUrl))
    throw new Error(
      "An attached image must be a base64 PNG, JPEG, or WebP data URL.",
    );
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  if (bytes.byteLength === 0)
    throw new Error("The attached image decoded to no bytes.");
  if (bytes.byteLength > MAX_IMAGE_ATTACHMENT_BYTES)
    throw new Error("An attached image must be 8 MB or smaller.");
  return bytes;
};

/** Decode, re-encode to PNG, and put the result in the project's artifact
 *  store. Returns the canonical ref, whose `uri` the studio renders directly. */
export const storeImageAttachment = async (input: {
  repository: ProjectRepository;
  projectId: string;
  dataUrl: string;
}): Promise<ArtifactRef> => {
  const source = dataUrlBytes(input.dataUrl);
  let png: Buffer;
  try {
    png = await sharp(source)
      .rotate()
      .resize({
        width: MAX_IMAGE_ATTACHMENT_PIXELS,
        height: MAX_IMAGE_ATTACHMENT_PIXELS,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  } catch {
    throw new Error("The attached image could not be read as an image.");
  }
  return input.repository.putArtifact(input.projectId, png, "image/png");
};

/** Turn ids supplied by the browser into refs this project actually owns. */
export const resolveImageAttachments = (
  repository: ProjectRepository,
  projectId: string,
  artifactIds: readonly string[] | undefined,
): ArtifactRef[] => {
  if (!artifactIds || artifactIds.length === 0) return [];
  if (artifactIds.length > MAX_IMAGE_ATTACHMENTS)
    throw new Error(
      `An answer can carry at most ${MAX_IMAGE_ATTACHMENTS} images.`,
    );
  return [...new Set(artifactIds)].map((artifactId) => {
    const ref = repository.getProjectArtifact(projectId, artifactId);
    if (!ref.mediaType.startsWith("image/"))
      throw new Error(`Artifact ${artifactId} is not an image.`);
    return ref;
  });
};

/** Load attachment bytes as provider frames. The caller supplies the label
 *  because the label is what the prompt text refers to — the model is told
 *  "A2.1" only if the transcript it reads also says "A2.1". */
export const attachmentFrames = (
  repository: ProjectRepository,
  entries: readonly { label: string; artifact: ArtifactRef }[],
): VisionFrameInput[] =>
  entries.map((entry) => ({
    label: entry.label,
    mediaType: "image/png" as const,
    bytes: repository.readArtifact(entry.artifact),
  }));
