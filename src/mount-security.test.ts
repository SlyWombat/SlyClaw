import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mount-security.ts has module-level cache for the loaded allowlist.
// We reset modules before each test and use dynamic imports so each test
// gets a fresh module instance with cleared cache.

let tmpDir: string;
let allowlistPath: string;
let allowedRootPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slyclaw-mount-test-'));
  allowlistPath = path.join(tmpDir, 'mount-allowlist.json');
  allowedRootPath = path.join(tmpDir, 'allowed-root');
  fs.mkdirSync(allowedRootPath);
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

async function loadModule() {
  vi.doMock('./config.js', () => ({
    MOUNT_ALLOWLIST_PATH: allowlistPath,
  }));
  vi.doMock('./logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));
  // pino is used directly in mount-security (not via logger.js), mock it too
  vi.doMock('pino', () => {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop };
    return { default: () => logger };
  });
  return await import('./mount-security.js');
}

function writeAllowlist(content: object) {
  fs.writeFileSync(allowlistPath, JSON.stringify(content));
}

function validAllowlist(overrides: object = {}) {
  return {
    allowedRoots: [{ path: allowedRootPath, allowReadWrite: true, description: 'Test root' }],
    blockedPatterns: [],
    nonMainReadOnly: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateAllowlistTemplate
// ---------------------------------------------------------------------------

describe('generateAllowlistTemplate', () => {
  it('returns valid JSON with required fields', async () => {
    const { generateAllowlistTemplate } = await loadModule();
    const json = generateAllowlistTemplate();
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed.allowedRoots)).toBe(true);
    expect(parsed.allowedRoots.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.blockedPatterns)).toBe(true);
    expect(typeof parsed.nonMainReadOnly).toBe('boolean');
  });

  it('includes expected root paths in template', async () => {
    const { generateAllowlistTemplate } = await loadModule();
    const parsed = JSON.parse(generateAllowlistTemplate());
    const rootPaths = parsed.allowedRoots.map((r: { path: string }) => r.path);
    expect(rootPaths).toContain('~/projects');
  });
});

// ---------------------------------------------------------------------------
// loadMountAllowlist
// ---------------------------------------------------------------------------

describe('loadMountAllowlist', () => {
  it('returns null when allowlist file does not exist', async () => {
    const { loadMountAllowlist } = await loadModule();
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when file contains invalid JSON', async () => {
    fs.writeFileSync(allowlistPath, 'not valid json');
    const { loadMountAllowlist } = await loadModule();
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when allowedRoots is missing', async () => {
    writeAllowlist({ blockedPatterns: [], nonMainReadOnly: false });
    const { loadMountAllowlist } = await loadModule();
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when blockedPatterns is missing', async () => {
    writeAllowlist({ allowedRoots: [], nonMainReadOnly: false });
    const { loadMountAllowlist } = await loadModule();
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns null when nonMainReadOnly is missing', async () => {
    writeAllowlist({ allowedRoots: [], blockedPatterns: [] });
    const { loadMountAllowlist } = await loadModule();
    expect(loadMountAllowlist()).toBeNull();
  });

  it('returns parsed allowlist on valid file', async () => {
    writeAllowlist(validAllowlist());
    const { loadMountAllowlist } = await loadModule();
    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result!.nonMainReadOnly).toBe(false);
  });

  it('merges default blocked patterns with custom ones', async () => {
    writeAllowlist(validAllowlist({ blockedPatterns: ['my-custom-secret'] }));
    const { loadMountAllowlist } = await loadModule();
    const result = loadMountAllowlist();
    expect(result!.blockedPatterns).toContain('my-custom-secret');
    expect(result!.blockedPatterns).toContain('.ssh'); // default
    expect(result!.blockedPatterns).toContain('.aws'); // default
  });

  it('deduplicates blocked patterns when default overlaps with custom', async () => {
    writeAllowlist(validAllowlist({ blockedPatterns: ['.ssh', 'my-secret'] }));
    const { loadMountAllowlist } = await loadModule();
    const result = loadMountAllowlist();
    const sshCount = result!.blockedPatterns.filter((p) => p === '.ssh').length;
    expect(sshCount).toBe(1);
  });

  it('caches result on second call', async () => {
    writeAllowlist(validAllowlist());
    const { loadMountAllowlist } = await loadModule();
    const first = loadMountAllowlist();
    const second = loadMountAllowlist();
    expect(first).toBe(second); // same reference
  });
});

// ---------------------------------------------------------------------------
// validateMount
// ---------------------------------------------------------------------------

describe('validateMount', () => {
  it('blocks when no allowlist file exists', async () => {
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: allowedRootPath }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('allowlist');
  });

  it('blocks when container path contains ..', async () => {
    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount(
      { hostPath: allowedRootPath, containerPath: '../escape' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('..');
  });

  it('blocks when container path starts with /', async () => {
    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount(
      { hostPath: allowedRootPath, containerPath: '/absolute/path' },
      true,
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks when container path is empty', async () => {
    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: allowedRootPath, containerPath: '   ' }, true);
    expect(result.allowed).toBe(false);
  });

  it('blocks when host path does not exist', async () => {
    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: path.join(tmpDir, 'nonexistent') }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('blocks when path matches a default blocked pattern (.ssh)', async () => {
    const sshDir = path.join(allowedRootPath, '.ssh');
    fs.mkdirSync(sshDir);
    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: sshDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('blocks when path matches a custom blocked pattern', async () => {
    const secretDir = path.join(allowedRootPath, 'my-tokens');
    fs.mkdirSync(secretDir);
    writeAllowlist(validAllowlist({ blockedPatterns: ['my-tokens'] }));
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: secretDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('my-tokens');
  });

  it('blocks when path is not under any allowed root', async () => {
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    writeAllowlist(validAllowlist()); // allowedRoot is tmpDir/allowed-root, not tmpDir/outside
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: outsideDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('allows valid path under allowed root (readonly by default)', async () => {
    const safeDir = path.join(allowedRootPath, 'safe-project');
    fs.mkdirSync(safeDir);
    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: safeDir }, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
    expect(result.realHostPath).toBe(safeDir);
  });

  it('defaults containerPath to basename of hostPath', async () => {
    const safeDir = path.join(allowedRootPath, 'my-project');
    fs.mkdirSync(safeDir);
    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: safeDir }, true);
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('my-project');
  });

  it('allows read-write when root permits and isMain=true', async () => {
    const safeDir = path.join(allowedRootPath, 'rw-project');
    fs.mkdirSync(safeDir);
    writeAllowlist(validAllowlist({ nonMainReadOnly: false }));
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: safeDir, readonly: false }, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('forces readonly for non-main group when nonMainReadOnly=true', async () => {
    const safeDir = path.join(allowedRootPath, 'rw-project');
    fs.mkdirSync(safeDir);
    writeAllowlist(validAllowlist({ nonMainReadOnly: true }));
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: safeDir, readonly: false }, false);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('forces readonly when allowedRoot.allowReadWrite=false even if readonly=false requested', async () => {
    const safeDir = path.join(allowedRootPath, 'ro-project');
    fs.mkdirSync(safeDir);
    writeAllowlist({
      allowedRoots: [{ path: allowedRootPath, allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: safeDir, readonly: false }, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security: symlink and path traversal attacks
// ---------------------------------------------------------------------------

describe('validateMount — security: symlink traversal', () => {
  it('blocks symlink inside allowed root that points outside', async () => {
    // Agent creates a symlink: allowed-root/link -> tmpDir/outside
    // realpathSync resolves it to outside/, which is not under allowed-root/
    const outsideDir = path.join(tmpDir, 'outside-sensitive');
    fs.mkdirSync(outsideDir);
    const symlinkPath = path.join(allowedRootPath, 'escape-link');
    fs.symlinkSync(outsideDir, symlinkPath);

    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: symlinkPath }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('resolves symlink that points within the allowed root (safe)', async () => {
    // Symlink to another directory still inside allowed root → allowed
    const realTarget = path.join(allowedRootPath, 'real-project');
    fs.mkdirSync(realTarget);
    const symlinkPath = path.join(allowedRootPath, 'link-to-project');
    fs.symlinkSync(realTarget, symlinkPath);

    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: symlinkPath }, true);
    expect(result.allowed).toBe(true);
  });
});

describe('validateMount — security: path traversal in hostPath', () => {
  it('blocks path traversal via relative segments (allowed-root/../outside)', async () => {
    const outsideDir = path.join(tmpDir, 'outside-sensitive');
    fs.mkdirSync(outsideDir);
    // Attempt traversal: start inside allowed-root but use .. to escape
    const traversalPath = path.join(allowedRootPath, '..', 'outside-sensitive');

    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: traversalPath }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('blocks traversal to a blocked-pattern path via relative segments', async () => {
    // Create .ssh inside tmpDir (outside allowed root)
    const sshDir = path.join(tmpDir, '.ssh');
    fs.mkdirSync(sshDir);
    // Traversal attempt into it from inside allowed root
    const traversalPath = path.join(allowedRootPath, '..', '.ssh');

    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: traversalPath }, true);
    expect(result.allowed).toBe(false);
  });
});

describe('validateMount — security: tilde expansion', () => {
  it('blocks ~/.ssh via tilde expansion hitting default blocked pattern', async () => {
    // HOME is set in test environment; ~/.ssh resolves to a blocked pattern
    // Even if the dir doesn't exist, getRealPath returns null → blocked as "does not exist"
    // If it does exist, it hits the .ssh blocked pattern
    // Either way, mounting ~/.ssh must be blocked.
    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: '~/.ssh' }, true);
    // Blocked either because path doesn't exist or because it matches .ssh pattern
    expect(result.allowed).toBe(false);
  });

  it('blocks ~/.aws via tilde expansion', async () => {
    writeAllowlist(validAllowlist());
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: '~/.aws' }, true);
    expect(result.allowed).toBe(false);
  });

  it('blocks home directory itself (not under any allowed root)', async () => {
    writeAllowlist(validAllowlist()); // allowed root is tmpDir/allowed-root, not HOME
    const { validateMount } = await loadModule();
    const result = validateMount({ hostPath: '~' }, true);
    // Either home dir is outside allowed root, or matches a blocked pattern
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateAdditionalMounts
// ---------------------------------------------------------------------------

describe('validateAdditionalMounts', () => {
  it('returns empty array when mounts is empty', async () => {
    writeAllowlist(validAllowlist());
    const { validateAdditionalMounts } = await loadModule();
    expect(validateAdditionalMounts([], 'main', true)).toEqual([]);
  });

  it('filters out rejected mounts', async () => {
    const safeDir = path.join(allowedRootPath, 'safe');
    fs.mkdirSync(safeDir);
    writeAllowlist(validAllowlist());
    const { validateAdditionalMounts } = await loadModule();
    const result = validateAdditionalMounts(
      [
        { hostPath: safeDir },
        { hostPath: path.join(tmpDir, 'nonexistent') },
      ],
      'main',
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0].hostPath).toBe(safeDir);
  });

  it('prefixes containerPath with /workspace/extra/', async () => {
    const safeDir = path.join(allowedRootPath, 'mydata');
    fs.mkdirSync(safeDir);
    writeAllowlist(validAllowlist());
    const { validateAdditionalMounts } = await loadModule();
    const result = validateAdditionalMounts([{ hostPath: safeDir }], 'main', true);
    expect(result[0].containerPath).toBe('/workspace/extra/mydata');
  });

  it('returns empty array when all mounts are rejected', async () => {
    // No allowlist file → all blocked
    const { validateAdditionalMounts } = await loadModule();
    const result = validateAdditionalMounts(
      [{ hostPath: allowedRootPath }],
      'main',
      true,
    );
    expect(result).toEqual([]);
  });
});
