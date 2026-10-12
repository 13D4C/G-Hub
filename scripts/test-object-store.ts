import assert from 'node:assert/strict'

process.env.S3_BUCKET = 'g-hub-media'
delete process.env.SEAWEED_S3_BUCKET
delete process.env.S3_ENDPOINT
delete process.env.SEAWEED_S3_ENDPOINT
process.env.AWS_REGION = 'us-east-1'

const { storedUrl, keyFromStoredUrl, publicHttpUrl } = await import(
  '../src/server/storage/object-store.ts'
)

for (const key of [
  'videos/6a986dd6f5a8502905efecf0/0b5c7e7e-3d1c-4b5e-9d59-1f7b6f1b2c3d/clip.mp4',
  'videos/6a986dd6f5a8502905efecf0/0b5c7e7e/hls/720p/segment-00042.ts',
  'ads/preroll.mp4',
  'videos/6a986dd6f5a8502905efecf0/abc/ความรัก.mp4',
  'videos/6a986dd6f5a8502905efecf0/abc/my holiday +1.mp4',
]) {
  assert.equal(keyFromStoredUrl(storedUrl(key)), key, `round trip failed for ${key}`)
}

assert.equal(storedUrl('videos/abc/clip.mp4'), 's3://g-hub-media/videos/abc/clip.mp4')

assert.equal(
  keyFromStoredUrl('http://10.30.32.33:8333/g-hub-media/videos/abc/clip.mp4'),
  'videos/abc/clip.mp4',
)
assert.equal(
  keyFromStoredUrl('https://some-other-host.example/g-hub-media/videos/abc/clip.mp4'),
  'videos/abc/clip.mp4',
)
assert.equal(
  keyFromStoredUrl('http://10.30.32.33:8333/g-hub-media/videos/abc/%E0%B8%A3%E0%B8%B1%E0%B8%81.mp4'),
  'videos/abc/รัก.mp4',
)

for (const url of [
  's3://someone-elses-bucket/videos/abc/clip.mp4',
  'http://10.30.32.33:8333/someone-elses-bucket/videos/abc/clip.mp4',
  's3://g-hub-media/',
  'videos/abc/clip.mp4',
  'not a url at all',
  '',
]) {
  assert.equal(keyFromStoredUrl(url), null, `expected null for ${JSON.stringify(url)}`)
}

assert.equal(
  publicHttpUrl('videos/abc/clip.mp4'),
  'https://g-hub-media.s3.us-east-1.amazonaws.com/videos/abc/clip.mp4',
)
assert.ok(publicHttpUrl('videos/abc/my holiday.mp4').endsWith('my%20holiday.mp4'))

console.log('object-store stored-url encoding: all assertions passed')
