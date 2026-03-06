import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// startIpcWatcher has a module-level ipcWatcherRunning flag.
// We reset modules + use dynamic imports to get fresh state per test.

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockCreateTask = vi.fn();
const mockGetTaskById = vi.fn();
const mockUpdateTask = vi.fn();
const mockDeleteTask = vi.fn();

vi.mock('./db.js', () => ({
  createTask: (...a: unknown[]) => mockCreateTask(...a),
  getTaskById: (...a: unknown[]) => mockGetTaskById(...a),
  updateTask: (...a: unknown[]) => mockUpdateTask(...a),
  deleteTask: (...a: unknown[]) => mockDeleteTask(...a),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

let tmpDir: string;
let ipcBaseDir: string;

function makeDeps(overrides: object = {}) {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    registeredGroups: vi.fn(() => ({
      'main@g.us': { name: 'Main', folder: 'main', trigger: '@Nano', added_at: '' },
      'other@g.us': { name: 'Other', folder: 'other-group', trigger: '@Nano', added_at: '' },
    })),
    registerGroup: vi.fn(),
    syncGroupMetadata: vi.fn().mockResolvedValue(undefined),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    ...overrides,
  };
}

async function importIpc() {
  vi.resetModules();
  vi.doMock('./config.js', () => ({
    DATA_DIR: tmpDir,
    IPC_POLL_INTERVAL: 100000, // large — prevents second tick during test
    MAIN_GROUP_FOLDER: 'main',
    TIMEZONE: 'UTC',
  }));
  vi.doMock('./logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));
  return await import('./ipc.js');
}

/** Write a JSON file into the IPC directory for a group. */
function writeIpcFile(
  groupFolder: string,
  subdir: 'messages' | 'tasks',
  filename: string,
  content: object,
) {
  const dir = path.join(ipcBaseDir, groupFolder, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(content));
}

/** Wait for the first processIpcFiles iteration to complete. */
async function tick() {
  // processIpcFiles is async; let all microtasks and I/O callbacks drain
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slyclaw-ipc-test-'));
  ipcBaseDir = path.join(tmpDir, 'ipc');
  mockCreateTask.mockReset();
  mockGetTaskById.mockReset();
  mockUpdateTask.mockReset();
  mockDeleteTask.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// startIpcWatcher — idempotency
// ---------------------------------------------------------------------------

describe('startIpcWatcher', () => {
  it('creates the IPC base directory on start', async () => {
    const { startIpcWatcher } = await importIpc();
    startIpcWatcher(makeDeps());
    await tick();
    expect(fs.existsSync(ipcBaseDir)).toBe(true);
  });

  it('does not start a second watcher if already running', async () => {
    const { startIpcWatcher } = await importIpc();
    const deps = makeDeps();
    startIpcWatcher(deps);
    startIpcWatcher(deps); // second call is no-op
    await tick();
    // registeredGroups is called once per iteration; with one loop it's called once
    expect(deps.registeredGroups.mock.calls.length).toBe(1);
  });

  it('handles empty IPC directory gracefully', async () => {
    const { startIpcWatcher } = await importIpc();
    fs.mkdirSync(ipcBaseDir, { recursive: true });
    const deps = makeDeps();
    startIpcWatcher(deps);
    await tick();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Message file processing
// ---------------------------------------------------------------------------

describe('message file processing', () => {
  it('sends message and deletes file for valid authorized message', async () => {
    const { startIpcWatcher } = await importIpc();
    const filePath = path.join(ipcBaseDir, 'main', 'messages', 'msg1.json');
    writeIpcFile('main', 'messages', 'msg1.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'Hello from agent',
    });

    const deps = makeDeps();
    startIpcWatcher(deps);
    await tick();

    expect(deps.sendMessage).toHaveBeenCalledWith('other@g.us', 'Hello from agent');
    expect(fs.existsSync(filePath)).toBe(false); // file deleted
  });

  it('blocks unauthorized message (non-main group sending to another group)', async () => {
    const { startIpcWatcher } = await importIpc();
    writeIpcFile('other-group', 'messages', 'unauth.json', {
      type: 'message',
      chatJid: 'main@g.us', // other-group trying to send to main's JID
      text: 'Unauthorized',
    });

    const deps = makeDeps();
    startIpcWatcher(deps);
    await tick();

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('allows non-main group to send to its own JID', async () => {
    const { startIpcWatcher } = await importIpc();
    writeIpcFile('other-group', 'messages', 'own.json', {
      type: 'message',
      chatJid: 'other@g.us', // other-group sending to its own JID
      text: 'My own message',
    });

    const deps = makeDeps();
    startIpcWatcher(deps);
    await tick();

    expect(deps.sendMessage).toHaveBeenCalledWith('other@g.us', 'My own message');
  });

  it('skips message files with missing chatJid or text', async () => {
    const { startIpcWatcher } = await importIpc();
    writeIpcFile('main', 'messages', 'incomplete.json', {
      type: 'message',
      // missing chatJid and text
    });

    const deps = makeDeps();
    startIpcWatcher(deps);
    await tick();

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('moves malformed JSON message file to errors directory', async () => {
    const { startIpcWatcher } = await importIpc();
    const dir = path.join(ipcBaseDir, 'main', 'messages');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not valid json{{');

    const deps = makeDeps();
    startIpcWatcher(deps);
    await tick();

    const errorsDir = path.join(ipcBaseDir, 'errors');
    expect(fs.existsSync(errorsDir)).toBe(true);
    expect(fs.existsSync(path.join(errorsDir, 'main-bad.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'bad.json'))).toBe(false);
  });

  it('only processes .json files (ignores other extensions)', async () => {
    const { startIpcWatcher } = await importIpc();
    const dir = path.join(ipcBaseDir, 'main', 'messages');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

    const deps = makeDeps();
    startIpcWatcher(deps);
    await tick();

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task file processing
// ---------------------------------------------------------------------------

describe('task file processing', () => {
  it('processes task file and deletes it after handling', async () => {
    const { startIpcWatcher } = await importIpc();
    const filePath = path.join(ipcBaseDir, 'main', 'tasks', 'task1.json');
    writeIpcFile('main', 'tasks', 'task1.json', {
      type: 'schedule_task',
      prompt: 'Do something',
      schedule_type: 'once',
      schedule_value: '2027-01-01T00:00:00.000Z',
      targetJid: 'other@g.us',
    });

    const deps = makeDeps();
    startIpcWatcher(deps);
    await tick();

    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        group_folder: 'other-group',
        prompt: 'Do something',
      }),
    );
    expect(fs.existsSync(filePath)).toBe(false); // file deleted
  });

  it('moves malformed JSON task file to errors directory', async () => {
    const { startIpcWatcher } = await importIpc();
    const dir = path.join(ipcBaseDir, 'main', 'tasks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not:json');

    const deps = makeDeps();
    startIpcWatcher(deps);
    await tick();

    const errorsDir = path.join(ipcBaseDir, 'errors');
    expect(fs.existsSync(path.join(errorsDir, 'main-broken.json'))).toBe(true);
  });

  it('processes pause_task and updates status', async () => {
    const { startIpcWatcher } = await importIpc();
    mockGetTaskById.mockReturnValue({
      id: 'task-abc',
      group_folder: 'main',
      status: 'active',
    });

    writeIpcFile('main', 'tasks', 'pause.json', {
      type: 'pause_task',
      taskId: 'task-abc',
    });

    const deps = makeDeps();
    startIpcWatcher(deps);
    await tick();

    expect(mockUpdateTask).toHaveBeenCalledWith('task-abc', { status: 'paused' });
  });

  it('processes cancel_task and deletes task from DB', async () => {
    const { startIpcWatcher } = await importIpc();
    mockGetTaskById.mockReturnValue({
      id: 'task-xyz',
      group_folder: 'main',
      status: 'active',
    });

    writeIpcFile('main', 'tasks', 'cancel.json', {
      type: 'cancel_task',
      taskId: 'task-xyz',
    });

    const deps = makeDeps();
    startIpcWatcher(deps);
    await tick();

    expect(mockDeleteTask).toHaveBeenCalledWith('task-xyz');
  });
});

// ---------------------------------------------------------------------------
// Multiple groups processed in same tick
// ---------------------------------------------------------------------------

describe('multi-group processing', () => {
  it('processes messages from multiple group directories in one tick', async () => {
    const { startIpcWatcher } = await importIpc();
    writeIpcFile('main', 'messages', 'msg-main.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'from main',
    });
    writeIpcFile('other-group', 'messages', 'msg-other.json', {
      type: 'message',
      chatJid: 'other@g.us',
      text: 'from other',
    });

    const deps = makeDeps();
    startIpcWatcher(deps);
    await tick();

    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
  });
});
