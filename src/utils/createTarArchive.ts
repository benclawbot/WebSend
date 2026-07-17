const TAR_BLOCK_SIZE = 512;
const TAR_PATH_LENGTH = 100;
const TAR_PREFIX_LENGTH = 155;

export interface BrowserFile extends File {
  webkitRelativePath?: string;
}

const encoder = new TextEncoder();

const writeString = (
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
) => {
  const encoded = encoder.encode(value);
  target.set(encoded.subarray(0, length), offset);
};

const writeOctal = (
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
) => {
  const octal = Math.max(0, value).toString(8).padStart(length - 1, '0');
  writeString(target, offset, length, `${octal}\0`);
};

const splitTarPath = (path: string) => {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  const encoded = encoder.encode(normalized);

  if (encoded.byteLength <= TAR_PATH_LENGTH) {
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
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  const { name, prefix } = splitTarPath(path);

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(modifiedAt / 1000));

  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, prefix);

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumValue = checksum.toString(8).padStart(6, '0');
  writeString(header, 148, 8, `${checksumValue}\0 `);

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
  if (files.length === 0) {
    throw new Error('No files were selected');
  }

  const entries = await Promise.all(files.map(async file => {
    const path = file.webkitRelativePath || file.name;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const paddingLength = (TAR_BLOCK_SIZE - (bytes.byteLength % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;

    return {
      header: createHeader(path, bytes.byteLength, file.lastModified || Date.now()),
      bytes,
      paddingLength,
    };
  }));

  const totalSize = entries.reduce(
    (sum, entry) => sum + TAR_BLOCK_SIZE + entry.bytes.byteLength + entry.paddingLength,
    TAR_BLOCK_SIZE * 2,
  );
  const archive = new Uint8Array(totalSize);
  let offset = 0;

  for (const entry of entries) {
    archive.set(entry.header, offset);
    offset += TAR_BLOCK_SIZE;
    archive.set(entry.bytes, offset);
    offset += entry.bytes.byteLength + entry.paddingLength;
  }

  const archiveName = `${sanitizeArchiveName(preferredName || 'websend-files')}.tar`;
  return new File([archive], archiveName, {
    type: 'application/x-tar',
    lastModified: Date.now(),
  });
}
