import { createHash, randomUUID } from 'crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { createRequire } from 'module';

// Bump when the YAML preflight, gray-matter parser or normalization changes.
const FORMAT = 'normalized-frontmatter-v1';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 16_384;
const MAX_VALUE_BYTES = 64 * 1024;
// Room for a few checkouts of a large vault, since stamps are per path.
const MAX_STAMPS = 32_768;
// A stamp vouches for a file only when the file last changed this long before
// it was taken. Any later write then carries a newer timestamp, even on
// filesystems that keep coarse ones (FAT rounds mtimes to two seconds).
const SETTLED_MS = 5_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Entry = [string, string, string]; // current input hash, normalized JSON, JSON checksum
type Stamp = [string, string, string]; // absolute path, file stamp, input hash of the bytes read after it
let parserRevision: string | undefined | null = null;

function getParserRevision(): string | undefined {
  if (parserRevision !== null) return parserRevision;
  try {
    const require = createRequire(import.meta.url);
    const matterRequire = createRequire(require.resolve('gray-matter/package.json'));
    const versions = [require('yaml/package.json').version, require('gray-matter/package.json').version,
      matterRequire('js-yaml/package.json').version];
    parserRevision = versions.every(value => typeof value === 'string') ? hash(JSON.stringify(versions)) : undefined;
  } catch {
    // An unusual package layout must not make cache setup a command failure.
    parserRevision = undefined;
  }
  return parserRevision;
}

/** A disposable parsing memo, not a file inventory, schema or identity authority. */
export class SnapshotParseCache {
  private readonly entries = new Map<string, Entry>();
  // Path to the stamp of the file when it was last read, and the hash of those bytes.
  private readonly stamps = new Map<string, Stamp>();
  private retainedBytes = 512; // Includes the serialized document header allowance.
  private changed = false;

  constructor(private readonly directory?: string) {}

  async load(): Promise<void> {
    if (!this.directory || !getParserRevision()) return;
    try {
      const file = join(this.directory, 'snapshot.json');
      if ((await stat(file)).size > MAX_BYTES) return;
      const document: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!isRecord(document) || document.format !== FORMAT || document.parser !== getParserRevision() ||
          document.node !== process.versions.node.split('.')[0] ||
          !Array.isArray(document.entries) || document.entries.length > MAX_ENTRIES ||
          document.checksum !== hash(JSON.stringify(document.entries))) return;
      // The file stores newest entries first; the Map iterates oldest first.
      for (const entry of [...document.entries].reverse()) {
        if (!Array.isArray(entry) || entry.length !== 3 ||
            !entry.every(value => typeof value === 'string')) continue;
        const [key, json, checksum] = entry as Entry;
        if (!/^[a-f0-9]{64}$/.test(key) || Buffer.byteLength(json) > MAX_VALUE_BYTES || hash(json) !== checksum) continue;
        this.retain([key, json, checksum]);
      }
      // Stamps have their own checksum, so a cache written without them, or
      // with damaged ones, still supplies its parsed entries.
      if (!Array.isArray(document.stamps) || document.stamps.length > MAX_STAMPS ||
          document.stampsChecksum !== hash(JSON.stringify(document.stamps))) return;
      for (const stamp of [...document.stamps].reverse()) {
        if (!Array.isArray(stamp) || stamp.length !== 3 ||
            !stamp.every(value => typeof value === 'string')) continue;
        const [path, fileStamp, key] = stamp as Stamp;
        if (!isAbsolute(path) || !/^\d+:\d+:\d+:\d+:\d+$/.test(fileStamp) || !/^[a-f0-9]{64}$/.test(key)) continue;
        this.retainStamp([path, fileStamp, key]);
      }
    } catch { /* Missing, corrupt or unreadable cache means fresh parsing. */ }
  }

  /**
   * Parse the note at `path`, skipping the read when the file's stamp (device,
   * file ID, size, mtime and ctime) still matches a settled earlier read whose
   * parse is retained. Any write changes ctime, even one that restores mtime.
   */
  async read(path: string, parse: (raw: string) => Record<string, unknown>): Promise<Record<string, unknown>> {
    // Stat before reading, so a stamp never vouches for bytes older than itself.
    const takenAt = Date.now();
    const info = await stat(path, { bigint: true });
    const fileStamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    const known = this.stamps.get(path);
    if (known) {
      const value = known[1] === fileStamp ? this.reuse(known[2]) : undefined;
      if (value) {
        this.stamps.delete(path);
        this.stamps.set(path, known);
        return value;
      }
      this.stamps.delete(path);
      this.changed = true;
    }
    const raw = await readFile(path, 'utf8');
    const key = hash(raw);
    const value = this.parseKeyed(key, () => parse(raw));
    const lastChange = info.mtimeNs > info.ctimeNs ? info.mtimeNs : info.ctimeNs;
    if (this.entries.has(key) && Number(lastChange / 1_000_000n) <= takenAt - SETTLED_MS) {
      this.retainStamp([path, fileStamp, key]);
      this.changed = true;
    }
    return value;
  }

  parse(raw: string, parse: () => Record<string, unknown>): Record<string, unknown> {
    return this.parseKeyed(hash(raw), parse);
  }

  private parseKeyed(key: string, parse: () => Record<string, unknown>): Record<string, unknown> {
    const cached = this.reuse(key);
    if (cached) return cached;
    const value = parse();
    // Exceptions, malformed notes and non-JSON values never become cache hits.
    try {
      if (reusable(value)) {
        const json = JSON.stringify(value);
        if (Buffer.byteLength(json) <= MAX_VALUE_BYTES) {
          this.retain([key, json, hash(json)]);
          this.changed = true;
        }
      }
    } catch { /* Unsupported/deep metadata must still return the parser's value. */ }
    return value;
  }

  private reuse(key: string): Record<string, unknown> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    try {
      const value: unknown = JSON.parse(entry[1]);
      if (isRecord(value) && reusable(value)) {
        this.entries.delete(key);
        this.entries.set(key, entry);
        // Return a fresh value: callers cannot mutate another snapshot's memo.
        return value;
      }
    } catch { /* Bad entry: the caller uses the actual parser. */ }
    this.remove(key);
    return undefined;
  }

  private retainStamp(stamp: Stamp): void {
    this.stamps.delete(stamp[0]);
    this.stamps.set(stamp[0], stamp);
    while (this.stamps.size > MAX_STAMPS) this.stamps.delete(this.stamps.keys().next().value!);
  }

  private remove(key: string): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.retainedBytes -= entryBytes(previous);
      this.entries.delete(key);
    }
  }

  private retain(entry: Entry): void {
    this.remove(entry[0]);
    this.entries.set(entry[0], entry);
    this.retainedBytes += entryBytes(entry);
    while (this.entries.size > MAX_ENTRIES || this.retainedBytes > MAX_BYTES) {
      this.remove(this.entries.keys().next().value!);
    }
  }

  async flush(): Promise<void> {
    if (!this.directory || !this.changed || !getParserRevision()) return;
    const temporary = join(this.directory, `snapshot-${process.pid}-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const entries: Entry[] = [];
      let bytes = 512;
      for (const entry of [...this.entries.values()].reverse()) {
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (bytes + size > MAX_BYTES) break;
        entries.push(entry);
        bytes += size;
      }
      // Stamps fill what the entries leave, and only for entries written here.
      const written = new Set(entries.map(entry => entry[0]));
      const stamps: Stamp[] = [];
      for (const stamp of [...this.stamps.values()].reverse()) {
        if (!written.has(stamp[2])) continue;
        const size = Buffer.byteLength(JSON.stringify(stamp)) + 1;
        if (bytes + size > MAX_BYTES) break;
        stamps.push(stamp);
        bytes += size;
      }
      const document = JSON.stringify({ format: FORMAT, parser: getParserRevision(), node: process.versions.node.split('.')[0],
        entries, checksum: hash(JSON.stringify(entries)), stamps, stampsChecksum: hash(JSON.stringify(stamps)) });
      await writeFile(temporary, document, { flag: 'wx', mode: 0o600 });
      // Concurrent writers can lose memo hits, never note content. Readers see a
      // complete old or new cache; Windows sharing errors merely drop this write.
      await rename(temporary, join(this.directory, 'snapshot.json'));
      this.changed = false;
    } catch { /* Caching cannot fail a read, validation or committed mutation. */ }
    finally { await unlink(temporary).catch(() => undefined); }
  }
}

function entryBytes(entry: Entry): number {
  return Buffer.byteLength(JSON.stringify(entry)) + 1;
}

/**
 * Fresh discovery remains mandatory even on a warm cache. A note's bytes are
 * read fresh unless its current stamp matches a settled earlier read.
 */
export async function openSnapshotParseCache(vaultDir: string, cacheHome = defaultCacheHome()): Promise<SnapshotParseCache> {
  let directory: string;
  try {
    const vault = await realpath(vaultDir);
    // Parsing depends on bytes, not paths/schema. Share a bounded memo across
    // short-lived transaction worktrees instead of allocating one per checkout.
    directory = await canonicalCachePath(resolve(cacheHome, 'bwrb', 'snapshot-parsing', `node-${process.versions.node.split('.')[0]}`));
    const inside = relative(vault, directory).replace(/\\/g, '/');
    if (inside === '' || (inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside))) return new SnapshotParseCache();
  } catch {
    return new SnapshotParseCache();
  }
  await cleanupAbandonedWrites(directory);
  const cache = new SnapshotParseCache(directory);
  await cache.load();
  return cache;
}

async function canonicalCachePath(path: string): Promise<string> {
  let ancestor = path;
  const tail: string[] = [];
  while (true) {
    try { return resolve(await realpath(ancestor), ...tail); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      // A dangling symlink is not a missing directory we should create through.
      const info = await lstat(ancestor).catch(() => undefined);
      if (info?.isSymbolicLink()) throw error;
      tail.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

function defaultCacheHome(): string {
  if (process.env.XDG_CACHE_HOME && isAbsolute(process.env.XDG_CACHE_HOME)) return process.env.XDG_CACHE_HOME;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA && isAbsolute(process.env.LOCALAPPDATA)) return join(process.env.LOCALAPPDATA, 'Cache');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches');
  return join(homedir(), '.cache');
}

async function cleanupAbandonedWrites(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const match = /^snapshot-([1-9][0-9]*)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid)) continue;
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isFile() && Date.now() - info.mtimeMs > 30_000) await unlink(path);
      }
    }
  } catch { /* Optional cache maintenance never blocks the command. */ }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function reusable(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (!value || typeof value !== 'object' || ancestors.has(value)) return false;
  if (Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype)) return false;
  if (Array.isArray(value) && Object.keys(value).length !== value.length) return false;
  ancestors.add(value);
  const valid = Object.values(value).every(child => reusable(child, ancestors));
  ancestors.delete(value);
  return valid;
}
