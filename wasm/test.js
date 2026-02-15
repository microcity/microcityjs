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

const initEventQ = wasmModule.cwrap('InitEventQ', null, ['number']);
const pushEvent = wasmModule.cwrap('PushEvent', null, ['number']);
const popEvent = wasmModule.cwrap('PopEvent', 'number', []);

initEventQ(16);
log('Event queue initialized');

pushEvent(0.5);
pushEvent(1.5);
pushEvent(2.0);
log('Pushed 3 event times');

while (true) {
  const time = popEvent();
  if (time === -1) break;
  log(`Popped event time=${time.toFixed(3)}`);
}

log('Done');
