import type { ResumeJob } from '@core/features/conversations/contributions/resume-settings';
import {
  invalidateAppSettingsKey,
  requestAppSettingsMeta,
  updateAppSettingsRequest,
} from '@core/features/settings/api/browser/app-settings-client';

let queue: Promise<unknown> = Promise.resolve();

/**
 * Every change to the job list goes through here, one at a time, starting from the
 * value the main process holds: the settings page and the watcher both write, and a
 * whole-list write from a stale copy would undo the other's change.
 */
export function changeResumeJobs(change: (jobs: ResumeJob[]) => ResumeJob[]): Promise<void> {
  const run = async () => {
    const meta = await requestAppSettingsMeta('resumeWriting');
    const next = change(meta.value.jobs);
    await updateAppSettingsRequest('resumeWriting', { jobs: next });
    invalidateAppSettingsKey('resumeWriting');
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

export const patchResumeJob = (id: string, patch: Partial<ResumeJob>) =>
  changeResumeJobs((jobs) => jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)));
export const addResumeJob = (job: ResumeJob) => changeResumeJobs((jobs) => [...jobs, job]);
export const removeResumeJob = (id: string) =>
  changeResumeJobs((jobs) => jobs.filter((job) => job.id !== id));
