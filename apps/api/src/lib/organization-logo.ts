import { z } from "zod";

/** Only small raster images are accepted; never external URLs or active SVG. */
export const organizationLogo = z.string().max(400_000).refine(value => {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const data = Buffer.from(match[2], "base64");
  if (data.length < 12 || data.length > 300_000) return false;
  if (match[1] === "png") return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (match[1] === "jpeg") return data[0] === 255 && data[1] === 216 && data[2] === 255;
  return data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
}, "Choose a PNG, JPEG or WebP logo under 300 KB.").nullable();
