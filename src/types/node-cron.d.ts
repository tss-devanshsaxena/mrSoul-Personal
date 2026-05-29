declare module 'node-cron' {
  export interface ScheduledTask {
    start(): void;
    stop(): void;
  }

  export interface ScheduleOptions {
    timezone?: string;
  }

  function schedule(
    expression: string,
    func: () => void,
    options?: ScheduleOptions
  ): ScheduledTask;

  function validate(expression: string): boolean;

  export default { schedule, validate };
}
