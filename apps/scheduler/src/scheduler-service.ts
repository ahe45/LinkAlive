import type { SchedulerStore } from './store.js';
import { CheckDispatcher } from './check-dispatcher.js';

export interface SchedulerRunResult {
  created: number;
  dispatched: number;
}

export class SchedulerService {
  constructor(
    private readonly store: SchedulerStore,
    private readonly dispatcher: CheckDispatcher,
    private readonly dueBatchSize: number,
    private readonly dispatchBatchSize: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<SchedulerRunResult> {
    const now = this.now();
    const created = await this.store.createDueChecks(now, this.dueBatchSize);
    const dispatched = await this.dispatcher.dispatch(now, this.dispatchBatchSize);
    return { created: created.length, dispatched };
  }
}
