import createModule from './des.js';

const output = document.getElementById('output');
const log = (msg) => {
  output.textContent += `${msg}\n`;
};

const wasmModule = await createModule({
  js_execute_event: (callbackId) => {
    log(`js_execute_event(${callbackId})`);
  }
});

const initSimulation = wasmModule.cwrap('InitSimulation', null, ['number']);
const scheduleEvent = wasmModule.cwrap('ScheduleEvent', 'number', ['number', 'number']);
const getSimTime = wasmModule.cwrap('GetSimTime', 'number', []);
const popAndExecuteOne = wasmModule.cwrap('PopAndExecuteOne', 'number', []);

initSimulation(16);
log('Simulation initialized');

scheduleEvent(101, 1.5);
scheduleEvent(102, 0.5);
scheduleEvent(103, 2.0);
log('Scheduled 3 events');

while (true) {
  const callbackId = popAndExecuteOne();
  if (callbackId === -1) break;
  const time = getSimTime();
  log(`Executed callbackId=${callbackId}, simTime=${time.toFixed(3)}`);
}

log('Done');
