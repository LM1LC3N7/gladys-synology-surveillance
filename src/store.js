// -----------------------------------------------------------------------------
// A small JSON file in the writable /data volume, for what the integration
// learns and must keep across restarts:
//   - deviceTokens: the device token DSM gives after a login with a 2-step
//     verification code (`did`), per NAS and account: the next logins skip
//     the code. It is a credential: never logged, file mode 0600.
//   - tlsPins: the SHA-256 fingerprint of the certificate trusted on first
//     use, per host:port.
//   - usedOtp: the last 2-step verification code sent, per NAS and account:
//     a code is single-use, the one left in the configuration is never sent
//     again after a restart.
//   - refusals: an HMAC (keyed with `meta.salt`) of the values DSM refused at
//     login, with the DSM code, per NAS and account: a restart (or a
//     reconnection to Gladys) with the same values does not log in again.
//   - motionMarks: the last motion events processed, per NAS
//     (`<start time, NAS clock>|<key>,<key>...`, every key of that second):
//     after a restart, an event already fired never fires again.
//   - meta: `salt`, a random key generated once for the HMAC above, and
//     `pausedUntil|<origin>`, the end of an HTTP 429 pause (ms).
// Writes are atomic (temporary file + rename) and queued. When the file
// cannot be written (no /data during development), values stay in memory.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SECTIONS = ['deviceTokens', 'tlsPins', 'usedOtp', 'refusals', 'motionMarks', 'meta'];
const EMPTY = () => Object.fromEntries(SECTIONS.map((section) => [section, {}]));

export class Store {
  #writes = Promise.resolve();

  /** @param {{ filePath: string, logger?: { warn: Function } }} options */
  constructor({ filePath, logger }) {
    this.filePath = filePath;
    this.logger = logger;
    this.data = EMPTY();
    this.loaded = null;
  }

  /** Reads the file once; later calls share the first read. */
  load() {
    this.loaded ??= readFile(this.filePath, 'utf8')
      .then((content) => {
        const parsed = JSON.parse(content);
        const pick = (value) =>
          Object.fromEntries(
            Object.entries(value && typeof value === 'object' ? value : {}).filter(
              ([, v]) => typeof v === 'string' && v,
            ),
          );
        this.data = Object.fromEntries(
          SECTIONS.map((section) => [section, pick(parsed?.[section])]),
        );
      })
      .catch((err) => {
        if (err.code !== 'ENOENT')
          this.logger?.warn(`Store unreadable, starting empty: ${err.message}`);
        this.data = EMPTY();
      });
    return this.loaded;
  }

  get(section, key) {
    return this.data[section]?.[key] ?? null;
  }

  async set(section, key, value) {
    if (value === null || value === undefined) delete this.data[section][key];
    else this.data[section][key] = value;
    await this.#save();
  }

  /** The random key of this installation (created on first use). */
  async salt() {
    let salt = this.get('meta', 'salt');
    if (!salt) {
      salt = randomBytes(32).toString('hex');
      await this.set('meta', 'salt', salt);
    }
    return salt;
  }

  #save() {
    const write = this.#writes.then(() => this.#write());
    this.#writes = write.catch(() => {});
    return write;
  }

  async #write() {
    const tmp = `${this.filePath}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.filePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      this.logger?.warn(`Store not saved, values kept in memory only: ${err.message}`);
    }
  }
}
