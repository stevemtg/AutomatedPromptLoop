import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { DisplayImage, LogDisplay } from './types';

// Separate binary attachments from the bounded text transcript before truncation.
export const MAX_IMAGE_DATA = 12 * 1024 * 1024;
export const MAX_IMAGES = 8;
const rasterMime = /^image\/(png|jpeg|jpg|webp|gif)$/i;
const imagePath = /\.(png|jpe?g|webp|gif)(?:[?#].*)?$/i;
const dataImage = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/\s]*={0,2})$/i;

export function extractImages(value: unknown): { value: unknown; images: DisplayImage[] } {
  const images: DisplayImage[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let nodes = 0;
  const add = (src: string, label = 'Tool image'): string => {
    const match = src.match(dataImage);
    if (src.startsWith('data:') && !match) return '[Unsupported image data]';
    if (!match && (!src || src.length > 8192 || /^(?!https?:|file:)[a-z][a-z\d+.-]+:/i.test(src) && !/^[a-z]:[\\/]/i.test(src))) return '[Unsupported image source]';
    if (match) src = `data:${match[1].toLowerCase().replace('image/jpg', 'image/jpeg')};base64,${match[2].replace(/\s/g, '')}`;
    if (!seen.has(src)) {
      if (images.length >= MAX_IMAGES || bytes + src.length > MAX_IMAGE_DATA) return '[Image preview omitted: size/count limit]';
      images.push({ src, label: label.slice(0, 300) }); seen.add(src); bytes += src.length;
    }
    return match ? `[Image: ${label.slice(0, 300)}]` : src;
  };
  const visit = (input: unknown, depth: number, imageContext = false): unknown => {
    if (++nodes > 10000 || depth > 12) return '[Nested output omitted]';
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (/^[\[{]/.test(trimmed)) {
        try { return JSON.stringify(visit(JSON.parse(trimmed), depth + 1, imageContext), null, 2); } catch { /* ordinary text */ }
      }
      if (/^data:image\//i.test(trimmed)) return add(trimmed);
      if ((imageContext || /^https?:\/\//i.test(trimmed)) && !/[\r\n]/.test(trimmed)
        && (imagePath.test(trimmed) || imageContext && /^https?:\/\//i.test(trimmed))) return add(trimmed);
      return input.replace(/!\[([^\]\n]*)\]\(([^\s)]+)\)/g, (_match, label: string, src: string) => add(src, label || 'Tool image'))
        .replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/gi, src => add(src));
    }
    if (Array.isArray(input)) return input.map(item => visit(item, depth + 1, imageContext));
    if (!input || typeof input !== 'object') return input;
    const record = input as Record<string, any>;
    const mime = record.mimeType ?? record.mediaType ?? record.mime_type ?? record.media_type;
    const label = typeof (record.name ?? record.title ?? record.alt) === 'string' ? record.name ?? record.title ?? record.alt : 'Tool image';
    const binary = record.data ?? record.blob;
    if (typeof binary === 'string' && (record.type === 'image' || typeof mime === 'string' && mime.startsWith('image/'))) {
      return typeof mime === 'string' && rasterMime.test(mime) ? add(`data:${mime};base64,${binary}`, label) : '[Unsupported image format]';
    }
    if (record.type === 'image' && record.source) return visit(record.source, depth + 1, true);
    if (record.type === 'image_url') return visit(record.image_url, depth + 1, true);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      const candidate = /^(images?|image_url|imageUrl|image_path|imagePath|output_path|output_file|file_path|filePath)$/.test(key)
        || /^(url|uri|path)$/.test(key) && (imageContext || record.type === 'image' || typeof mime === 'string' && rasterMime.test(mime) || typeof item === 'string' && imagePath.test(item));
      result[key] = visit(item, depth + 1, candidate);
    }
    return result;
  };
  return { value: visit(value, 0), images };
}

/** Content-addressed files keep image bytes out of state messages and workspace storage. */
export class ImageCache {
  constructor(readonly directory: string, private readonly report: (message: string) => void) {}
  prepare(display: LogDisplay): LogDisplay {
    if (display.type !== 'tool' || !display.images?.length) return display;
    return { ...display, images: display.images.map(image => {
      const match = image.src.match(dataImage);
      if (!match) return image;
      try {
        const data = Buffer.from(match[2], 'base64');
        const filename = `${createHash('sha256').update(data).digest('hex')}.${match[1].split('/')[1]}`;
        const file = path.join(this.directory, filename);
        if (!existsSync(file)) { mkdirSync(this.directory, { recursive: true }); writeFileSync(file, data); }
        return { ...image, src: file };
      } catch (error) {
        this.report(`Could not cache tool image: ${error}`);
        return { src: '', label: `${image.label} (preview unavailable)` };
      }
    }) };
  }
}
