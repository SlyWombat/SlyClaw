import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// task-scheduler.ts has a module-level `schedulerRunning` flag.
// We reset modules before each test to get fresh state.

vi.mock('./config.js', () => ({
  SCHEDULER_POLL_INTERVAL: 50,
  TIMEZONE: 'UTC',
  GROUPS_DIR: '/tmp/slyclaw-test-groups',
  MAIN_GROUP_FOLDER: 'main',
  IDLE_TIMEOUT: 5000,
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: { ...actual, mkdirSync: vi.fn() } };
});

// Mocks set up per-test via vi.resetModules() + dynamic import
const mockGetDueTasks = vi.fn<() => unknown[]>(() => []);
const mockGetTaskById = vi.fn();
const mockClaimTask = vi.fn();
const mockGetAllTasks = vi.fn(() => []);
const mockLogTaskRun = vi.fn();
const mockUpdateTaskAfterRun = vi.fn();
const mockRunContainerAgent = vi.fn();
const mockWriteTasksSnapshot = vi.fn();

vi.mock('./db.js', () => ({
  getDueTasks: () => mockGetDueTasks(),
  getTaskById: (...args: unknown[]) => mockGetTaskById(...args),
  claimTask: (...args: unknown[]) => mockClaimTask(...args),
  getAllTasks: () => mockGetAllTasks(),
  logTaskRun: (...args: unknown[]) => mockLogTaskRun(...args),
  updateTaskAfterRun: (...args: unknown[]) => mockUpdateTaskAfterRun(...args),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: (...args: unknown[]) => mockRunContainerAgent(...args),
  writeTasksSnapshot: (...args: unknown[]) => mockWriteTasksSnapshot(...args),
}));

function makeTask(overrides: object = {}) {
  return {
    id: 'task-1',
    group_folder: 'main',
    chat_jid: '111@g.us',
    prompt: 'Say hello',
    schedule_type: 'cron' as const,
    schedule_value: '0 8 * * *',
    context_mode: 'isolated' as const,
    next_run: new Date(Date.now() - 1000).toISOString(),
    last_run: null,
    last_result: null,
    status: 'active' as const,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(overrides: object = {}) {
  const queue = {
    enqueueTask: vi.fn(),
    closeStdin: vi.fn(),
  };
  return {
    registeredGroups: vi.fn(() => ({
      '111@g.us': { folder: 'main', name: 'Main', trigger: '@Nano', added_at: '' },
    })),
    getSessions: vi.fn(() => ({})),
    queue,
    onProcess: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  mockGetDueTasks.mockReturnValue([]);
  mockGetTaskById.mockReturnValue(null);
  mockClaimTask.mockReset();
  mockGetAllTasks.mockReturnValue([]);
  mockLogTaskRun.mockReset();
  mockUpdateTaskAfterRun.mockReset();
  mockRunContainerAgent.mockReset();
  mockWriteTasksSnapshot.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function importScheduler() {
  vi.doMock('./config.js', () => ({
    SCHEDULER_POLL_INTERVAL: 50,
    TIMEZONE: 'UTC',
    GROUPS_DIR: '/tmp/slyclaw-test-groups',
    MAIN_GROUP_FOLDER: 'main',
    IDLE_TIMEOUT: 5000,
  }));
  vi.doMock('./logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));
  return await import('./task-scheduler.js');
}

// ---------------------------------------------------------------------------
// startSchedulerLoop — loop control
// ---------------------------------------------------------------------------

describe('startSchedulerLoop', () => {
  it('does not start a second loop if already running', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const deps = makeDeps();
    // First call: loop runs immediately (1 call) then schedules next tick at 50ms
    startSchedulerLoop(deps);
    // Second call must be a no-op — schedulerRunning is already true
    startSchedulerLoop(deps);
    // Advance one poll interval: only one loop fires, so getDueTasks called exactly 2x
    // (once immediately + once from the timeout). If two loops ran it would be 4x.
    await vi.advanceTimersByTimeAsync(50);
    expect(mockGetDueTasks.mock.calls.length).toBe(2);
  });

  it('calls getDueTasks on each poll tick', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(50);
    expect(mockGetDueTasks).toHaveBeenCalled();
  });

  it('does nothing when no due tasks', async () => {
    const { startSchedulerLoop } = await importScheduler();
    mockGetDueTasks.mockReturnValue([]);
    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(50);
    expect(deps.queue.enqueueTask).not.toHaveBeenCalled();
  });

  it('skips task if current status is not active', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const task = makeTask();
    mockGetDueTasks.mockReturnValue([task]);
    mockGetTaskById.mockReturnValue({ ...task, status: 'paused' });
    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(50);
    expect(deps.queue.enqueueTask).not.toHaveBeenCalled();
  });

  it('skips task if getTaskById returns null (deleted mid-flight)', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const task = makeTask();
    mockGetDueTasks.mockReturnValue([task]);
    mockGetTaskById.mockReturnValue(null);
    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(50);
    expect(deps.queue.enqueueTask).not.toHaveBeenCalled();
  });

  it('claims task and enqueues it when active', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const task = makeTask();
    mockGetDueTasks.mockReturnValue([task]);
    mockGetTaskById.mockReturnValue(task);
    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(50);
    expect(mockClaimTask).toHaveBeenCalledWith(task.id, expect.any(String));
    expect(deps.queue.enqueueTask).toHaveBeenCalledWith(
      task.chat_jid,
      task.id,
      expect.any(Function),
    );
  });

  it('advances next_run as an ISO timestamp for cron tasks', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const task = makeTask({ schedule_type: 'cron', schedule_value: '0 8 * * *' });
    mockGetDueTasks.mockReturnValue([task]);
    mockGetTaskById.mockReturnValue(task);
    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(50);
    const [, nextRun] = mockClaimTask.mock.calls[0] as [string, string];
    expect(new Date(nextRun).getTime()).toBeGreaterThan(Date.now());
  });

  it('advances next_run by interval ms for interval tasks', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const intervalMs = 3600000; // 1 hour
    const task = makeTask({ schedule_type: 'interval', schedule_value: String(intervalMs) });
    mockGetDueTasks.mockReturnValue([task]);
    mockGetTaskById.mockReturnValue(task);
    const deps = makeDeps();
    startSchedulerLoop(deps);
    const before = Date.now();
    await vi.advanceTimersByTimeAsync(50);
    const [, nextRun] = mockClaimTask.mock.calls[0] as [string, string];
    const nextRunMs = new Date(nextRun).getTime();
    expect(nextRunMs).toBeGreaterThanOrEqual(before + intervalMs);
  });

  it('only fires each task once per poll tick', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const task = makeTask();
    mockGetDueTasks
      .mockReturnValueOnce([task]) // first tick: one due task
      .mockReturnValue([]); // subsequent ticks: nothing due
    mockGetTaskById.mockReturnValue(task);
    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(200);
    expect(deps.queue.enqueueTask).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runTask (exercised via enqueued function)
// ---------------------------------------------------------------------------

describe('runTask (via enqueued function)', () => {
  it('logs error and does not crash when group is not found', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const task = makeTask({ group_folder: 'unknown-group' });
    mockGetDueTasks.mockReturnValueOnce([task]).mockReturnValue([]);
    mockGetTaskById.mockReturnValue(task);
    const deps = makeDeps({
      registeredGroups: vi.fn(() => ({})), // no groups registered
    });
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(50);

    // Grab and run the enqueued function
    const enqueuedFn = (deps.queue.enqueueTask as ReturnType<typeof vi.fn>).mock
      .calls[0][2] as () => Promise<void>;
    await enqueuedFn();

    expect(mockLogTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: expect.stringContaining('not found') }),
    );
    expect(mockRunContainerAgent).not.toHaveBeenCalled();
  });

  it('runs container agent and sends result to chat', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const task = makeTask();
    mockGetDueTasks.mockReturnValueOnce([task]).mockReturnValue([]);
    mockGetTaskById.mockReturnValue(task);
    mockGetAllTasks.mockReturnValue([task]);
    mockRunContainerAgent.mockImplementation(
      async (_group: unknown, _input: unknown, _onProc: unknown, onOutput: (o: { result?: string; status?: string }) => Promise<void>) => {
        await onOutput({ result: 'Hello from agent' });
        return { status: 'success', result: 'Hello from agent' };
      },
    );
    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(50);

    const enqueuedFn = (deps.queue.enqueueTask as ReturnType<typeof vi.fn>).mock
      .calls[0][2] as () => Promise<void>;
    await enqueuedFn();

    expect(deps.sendMessage).toHaveBeenCalledWith(task.chat_jid, 'Hello from agent');
    expect(mockLogTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
    expect(mockUpdateTaskAfterRun).toHaveBeenCalledWith(task.id, expect.any(String));
  });

  it('logs error status when container agent returns error', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const task = makeTask();
    mockGetDueTasks.mockReturnValueOnce([task]).mockReturnValue([]);
    mockGetTaskById.mockReturnValue(task);
    mockGetAllTasks.mockReturnValue([]);
    mockRunContainerAgent.mockResolvedValue({ status: 'error', error: 'Container crashed' });
    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(50);

    const enqueuedFn = (deps.queue.enqueueTask as ReturnType<typeof vi.fn>).mock
      .calls[0][2] as () => Promise<void>;
    await enqueuedFn();

    expect(mockLogTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'Container crashed' }),
    );
  });

  it('uses group session for context_mode=group tasks', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const sessionId = 'existing-session-abc';
    const task = makeTask({ context_mode: 'group' });
    mockGetDueTasks.mockReturnValueOnce([task]).mockReturnValue([]);
    mockGetTaskById.mockReturnValue(task);
    mockGetAllTasks.mockReturnValue([]);
    mockRunContainerAgent.mockResolvedValue({ status: 'success', result: 'Done' });
    const deps = makeDeps({ getSessions: vi.fn(() => ({ main: sessionId })) });
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(50);

    const enqueuedFn = (deps.queue.enqueueTask as ReturnType<typeof vi.fn>).mock
      .calls[0][2] as () => Promise<void>;
    await enqueuedFn();

    expect(mockRunContainerAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('passes no sessionId for context_mode=isolated tasks', async () => {
    const { startSchedulerLoop } = await importScheduler();
    const task = makeTask({ context_mode: 'isolated' });
    mockGetDueTasks.mockReturnValueOnce([task]).mockReturnValue([]);
    mockGetTaskById.mockReturnValue(task);
    mockGetAllTasks.mockReturnValue([]);
    mockRunContainerAgent.mockResolvedValue({ status: 'success', result: 'Done' });
    const deps = makeDeps({ getSessions: vi.fn(() => ({ main: 'some-session' })) });
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(50);

    const enqueuedFn = (deps.queue.enqueueTask as ReturnType<typeof vi.fn>).mock
      .calls[0][2] as () => Promise<void>;
    await enqueuedFn();

    expect(mockRunContainerAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: undefined }),
      expect.any(Function),
      expect.any(Function),
    );
  });
});
