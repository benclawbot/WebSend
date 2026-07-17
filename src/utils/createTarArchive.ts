const TAR_BLOCK_SIZE = 512;
const TAR_PATH_LENGTH = 100;
const TAR_PREFIX_LENGTH = 155;
const TAR_SIZE_FIELD_LENGTH = 12;
const TAR_MAX_FILE_SIZE = Number.parseInt('77777777777', 8);

export type BrowserFile = File;

const encoder = new TextEncoder();

const asArrayBuffer = (bytes: Uint8Array) => bytes.buffer.slice(
  bytes.byteOffset,
  bytes.byteOffset + bytes.byteLength,
) as ArrayBuffer;

const writeString = (
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
) => {
  const encoded = encoder.encode(value);
  if (encoded.byteLength > length) {
    throw new Error(`Value is too long for a TAR header field: ${value}`);
  }
  target.set(encoded, offset);
};

const writeOctal = (
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
) => {
  const octal = Math.max(0, Math.floor(value)).toString(8);
  if (octal.length > length - 1) {
    throw new Error(`Numeric value is too large for a TAR header: ${value}`);
  }
  writeString(target, offset, length, `${octal.padStart(length - 1, '0')}\0`);
};

const normalizeArchivePath = (path: string) => {
  const normalized = path
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(segment => segment && segment !== '.' && segment !== '..')
    .join('/');

  if (!normalized) throw new Error('A selected file has an invalid archive path');
  return normalized;
};

const splitTarPath = (path: string) => {
  const normalized = normalizeArchivePath(path);
  if (encoder.encode(normalized).byteLength <= TAR_PATH_LENGTH) {
    return { name: normalized, prefix: '' };
  }

  const segments = normalized.split('/');
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join('/');
    const name = segments.slice(index).join('/');
    if (
      encoder.encode(name).byteLength <= TAR_PATH_LENGTH &&
      encoder.encode(prefix).byteLength <= TAR_PREFIX_LENGTH
    ) {
      return { name, prefix };
    }
  }

  throw new Error(`Path is too long for a TAR archive: ${normalized}`);
};

const createHeader = (path: string, size: number, modifiedAt: number) => {
  if (size > TAR_MAX_FILE_SIZE) {
    throw new Error(`File is too large for a USTAR archive: ${path}`);
  }

  const header = new Uint8Array(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarPath(path);

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, TAR_SIZE_FIELD_LENGTH, size);
  writeOctal(header, 136, 12, Math.floor(modifiedAt / 1000));
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, prefix);

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
};

const sanitizeArchiveName = (name: string) => {
  const sanitized = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'websend-files';
};

export async function createTarArchive(
  files: BrowserFile[],
  preferredName?: string,
): Promise<File> {
  if (files.length === 0) throw new Error('No files were selected');

  const parts: BlobPart[] = [];
  const usedPaths = new Set<string>();

  for (const file of files) {
    const path = normalizeArchivePath(file.webkitRelativePath || file.name);
    if (usedPaths.has(path)) {
      throw new Error(`Duplicate file path in selection: ${path}`);
    }
    usedPaths.add(path);

    const header = createHeader(path, file.size, file.lastModified || Date.now());
    const paddingLength = (TAR_BLOCK_SIZE - (file.size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    parts.push(asArrayBuffer(header), file);
    if (paddingLength > 0) {
      parts.push(new ArrayBuffer(paddingLength));
    }
  }

  parts.push(new ArrayBuffer(TAR_BLOCK_SIZE * 2));
  const archiveName = `${sanitizeArchiveName(preferredName || 'websend-files')}.tar`;
  return new File(parts, archiveName, {
    type: 'application/x-tar',
    lastModified: Date.now(),
  });
}
