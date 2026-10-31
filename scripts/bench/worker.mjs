// A bench worker: runs its share of the tasks and posts the records back,
// with a progress count every few tasks.
import { parentPort, workerData } from 'node:worker_threads';
import { runTask } from './rep.mjs';

const results = [];
let since = 0;
for (const task of workerData.tasks) {
  results.push({ order: task.order, result: runTask(task) });
  if (++since === 10) { parentPort.postMessage({ progress: since }); since = 0; }
}
parentPort.postMessage({ progress: since, results });
