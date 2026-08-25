import { createHash } from "node:crypto";

import type { ConceptViewRole } from "@fulcrum/domain";
import type { SubscriptionImageRunner } from "@fulcrum/execution";
import sharp from "sharp";

const ROLE_STYLE: Record<
  ConceptViewRole,
  { accent: string; markerX: number; bodyWidth: number }
> = {
  front: { accent: "#35d9ef", markerX: 512, bodyWidth: 430 },
  left: { accent: "#e7b65a", markerX: 292, bodyWidth: 350 },
  back: { accent: "#9f8cff", markerX: 512, bodyWidth: 390 },
  right: { accent: "#ef7e69", markerX: 732, bodyWidth: 350 },
};

const fixtureSvg = (role: ConceptViewRole, anchorHash: string): string => {
  const style = ROLE_STYLE[role];
  const shortHash = anchorHash.slice(0, 12);
  const bodyLeft = 512 - style.bodyWidth / 2;
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <rect width="1024" height="1024" fill="#e9e7e1"/>
      <circle cx="512" cy="500" r="360" fill="#f6f4ee" stroke="#c9c5ba" stroke-width="4"/>
      <ellipse cx="512" cy="815" rx="280" ry="48" fill="#252b31" opacity="0.16"/>
      <rect x="${bodyLeft}" y="320" width="${style.bodyWidth}" height="460" rx="72" fill="#313b42" stroke="#171c20" stroke-width="18"/>
      <path d="M330 400 L512 238 L694 400" fill="#46535a" stroke="#171c20" stroke-width="18" stroke-linejoin="round"/>
      <rect x="322" y="482" width="380" height="44" rx="18" fill="#8b6a39"/>
      <rect x="322" y="650" width="380" height="44" rx="18" fill="#8b6a39"/>
      <path d="M512 420 L590 546 L512 674 L434 546 Z" fill="${style.accent}" stroke="#d8fbff" stroke-width="14"/>
      <circle cx="${style.markerX}" cy="546" r="24" fill="#ffffff" stroke="${style.accent}" stroke-width="12"/>
      <text x="512" y="910" text-anchor="middle" font-family="monospace" font-size="38" fill="#252b31">${role.toUpperCase()} · ${shortHash}</text>
    </svg>`;
};

export const createMultiviewReplayRunner =
  (role: ConceptViewRole): SubscriptionImageRunner =>
  async ({ referenceImages = [] }) => {
    const anchor = referenceImages[0];
    if (!anchor) {
      throw new Error(
        "Multiview replay generation requires the anchor reference as Image 1.",
      );
    }
    const anchorHash = createHash("sha256").update(anchor.bytes).digest("hex");
    const bytes = await sharp(Buffer.from(fixtureSvg(role, anchorHash)))
      .png({ compressionLevel: 9, adaptiveFiltering: false })
      .toBuffer();
    return {
      bytes,
      model: "fulcrum-multiview-replay-v1",
      costUsd: 0,
    };
  };
