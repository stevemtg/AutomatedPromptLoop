import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { extractImages, ImageCache, MAX_IMAGE_DATA, MAX_IMAGES } from '../images';
import { NdjsonParser, normalizeEvent } from '../ndjson';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VAAAAABJRU5ErkJggg==';
const dataUri = `data:image/png;base64,${png}`;

test('MCP and Cline images survive text truncation, nested JSON and mixed content', () => {
  for (const toolName of ['generate_image', 'crop_zoom', 'check_transparency', 'remove_bg']) {
    const event = normalizeEvent({type:'agent_event',event:{type:'content_end',contentType:'tool',toolName,output:{
      result: JSON.stringify({content:[{type:'text',text:'x'.repeat(21000)}, {type:'image',mimeType:'image/png',data:png}]}),
      images: [{type:'image',mediaType:'image/png',data:png}]
    }}});
    assert.ok(event.display?.type === 'tool');
    assert.deepEqual(event.display.images, [{src:dataUri,label:'Tool image'}]);
    assert.match(event.display.output!, /Truncated/);
    assert.ok(!event.message.includes(png));
  }
  const embedded = extractImages({content:[{type:'resource',resource:{mimeType:'image/png',blob:png}}]});
  assert.equal(embedded.images[0].src, dataUri);
  assert.ok(!JSON.stringify(embedded.value).includes(png));
  assert.equal(extractImages({type:'image',source:{type:'base64',media_type:'image/png',data:png}}).images[0].src, dataUri);
});

test('image URLs, workspace paths and markdown keep labels and deduplicate', () => {
  const result = extractImages({content:[
    {type:'text',text:'![Preview](https://example.com/render.png)'},
    {type:'image_url',image_url:{url:'https://example.com/render.png'}},
    {output_path:'renders/cropped.png'},
    {image_url:'https://example.com/render?id=1'},
    {type:'resource_link',mimeType:'image/png',uri:'file:///project/transparent.png'}
  ]});
  assert.equal(result.images.length, 4);
  assert.deepEqual(result.images[0], {src:'https://example.com/render.png',label:'Preview'});
  assert.equal(result.images[1].src, 'renders/cropped.png');
});

test('unsafe, unsupported and excessive image content is omitted without losing text', () => {
  const result = extractImages({content:[
    {type:'text',text:'Transparency: 42%'},
    {type:'image',mimeType:'image/svg+xml',data:'PHN2Zz4='},
    {type:'image',mimeType:'image/png',data:'bad" onerror="alert(1)'},
    {type:'text',text:'![bad](javascript:alert) ![bad](command:run)'},
    {type:'image',mimeType:'image/png',data:'A'.repeat(MAX_IMAGE_DATA + 1)}
  ]});
  assert.equal(result.images.length, 0);
  assert.match(JSON.stringify(result.value), /Transparency: 42%/);
  assert.ok(JSON.stringify(result.value).length < 1000);
  assert.equal(extractImages({images:Array.from({length:20}, (_, i) => `https://example.com/${i}.png`)}).images.length, MAX_IMAGES);
  const textOnly = normalizeEvent({type:'tool_result',toolName:'check_transparency',output:{has_transparency:true,percentage:42}});
  assert.ok(textOnly.display?.type === 'tool');
  assert.equal(textOnly.display.images, undefined);
  assert.match(textOnly.display.output!, /has_transparency/);
  const error = normalizeEvent({type:'tool_result',output:{isError:true,content:[{type:'text',text:'Failed'}]}}).display;
  assert.ok(error?.type === 'tool');
  assert.equal(error.status, 'failed');
  assert.equal(error.output, 'Failed');
});

test('image cache preserves reloadable files without binary payloads in display state', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'prompt-loop-images-'));
  try {
    const cache = new ImageCache(directory, error => assert.fail(error));
    const event = normalizeEvent({type:'tool_result',toolName:'generate_image',output:{type:'image',mimeType:'image/png',data:png}});
    const display = cache.prepare(event.display!);
    assert.ok(display.type === 'tool');
    assert.deepEqual(readFileSync(display.images![0].src), Buffer.from(png,'base64'));
    assert.ok(!JSON.stringify(display).includes(png));
    cache.prepare(event.display!);
    assert.equal(readdirSync(directory).length, 1);
  } finally { rmSync(directory, {recursive:true,force:true}); }
});

test('NDJSON accepts images larger than the former 4 MiB limit across split chunks', () => {
  const records: unknown[] = [];
  const parser = new NdjsonParser(record => records.push(record), error => assert.fail(error));
  const line = JSON.stringify({type:'tool_result',output:{type:'image',mimeType:'image/png',data:'A'.repeat(5 * 1024 * 1024)}});
  for (let offset = 0; offset < line.length; offset += 65536) parser.write(line.slice(offset, offset + 65536));
  parser.end();
  assert.equal(records.length, 1);
  const display = normalizeEvent(records[0]).display;
  assert.ok(display?.type === 'tool');
  assert.equal(display.images?.length, 1);
  assert.ok(display.output!.length < 100);
});
