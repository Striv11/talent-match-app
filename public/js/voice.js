import { api } from './core.js';

const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

const v = {
  active: false,
  socket: null,
  audioContext: null,
  audioStream: null,
  micNode: null,
  micChunks: [],
  micChunkLength: 0,
  playbackSources: new Set(),
  nextPlaybackTime: 0,
  sessionReady: false,
  stopWhenTurnEnds: false,
  userText: '',
  modelText: '',
  lastUserText: '',
  persona: 'candidate',
  hooks: {}
};

export const isVoiceActive = () => v.active;

function emit(name, ...args) {
  v.hooks[name]?.(...args);
}

function setStatus(status, detail) {
  emit('onStatus', status, detail);
}

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function resampleTo16k(samples, inputRate) {
  const outputLength = Math.floor((samples.length * 16000) / inputRate);
  const output = new Int16Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = (index * inputRate) / 16000;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = sourceIndex - left;
    const value = samples[left] * (1 - fraction) + samples[right] * fraction;
    output[index] = Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767);
  }
  return output;
}

function rms(samples) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 8) sum += samples[index] * samples[index];
  return Math.sqrt(sum / Math.max(1, samples.length / 8));
}

function sendMicAudio(samples) {
  v.micChunks.push(samples);
  v.micChunkLength += samples.length;
  if (v.micChunkLength < 4096 || !v.sessionReady || v.socket?.readyState !== WebSocket.OPEN) return;
  const combined = new Float32Array(v.micChunkLength);
  let offset = 0;
  v.micChunks.forEach((chunk) => {
    combined.set(chunk, offset);
    offset += chunk.length;
  });
  v.micChunks = [];
  v.micChunkLength = 0;
  if (!v.playbackSources.size) emit('onLevel', Math.min(1, rms(combined) * 6), 'user');
  const pcm = resampleTo16k(combined, v.audioContext.sampleRate);
  v.socket.send(JSON.stringify({ realtimeInput: { audio: { data: encodeBase64(new Uint8Array(pcm.buffer)), mimeType: 'audio/pcm;rate=16000' } } }));
}

function startMicCapture() {
  const source = v.audioContext.createMediaStreamSource(v.audioStream);
  v.micNode = new AudioWorkletNode(v.audioContext, 'jack-jill-mic');
  const silent = v.audioContext.createGain();
  silent.gain.value = 0;
  v.micNode.port.onmessage = (event) => sendMicAudio(event.data);
  source.connect(v.micNode);
  v.micNode.connect(silent);
  silent.connect(v.audioContext.destination);
}

function playAudioChunk(base64Audio, mimeType = '') {
  if (!v.audioContext || !v.active) return;
  const sampleRate = Number(mimeType.match(/rate=(\d+)/)?.[1]) || 24000;
  const bytes = decodeBase64(base64Audio);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const buffer = v.audioContext.createBuffer(1, samples.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index += 1) channel[index] = samples[index] / 32768;
  emit('onLevel', Math.min(1, rms(channel) * 5), 'agent');

  const source = v.audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(v.audioContext.destination);
  const startAt = Math.max(v.audioContext.currentTime + 0.02, v.nextPlaybackTime);
  v.nextPlaybackTime = startAt + buffer.duration;
  v.playbackSources.add(source);
  source.onended = () => {
    v.playbackSources.delete(source);
    if (v.active && !v.playbackSources.size) setStatus('listening');
  };
  source.start(startAt);
  setStatus('speaking');
}

function stopPlayback() {
  v.playbackSources.forEach((source) => {
    try { source.stop(); } catch (error) { /* already stopped */ }
  });
  v.playbackSources.clear();
  v.nextPlaybackTime = v.audioContext ? v.audioContext.currentTime : 0;
}

function merge(existing, incoming) {
  const current = existing.trim();
  const next = incoming.trim();
  if (!current || next.startsWith(current)) return next;
  if (current.endsWith(next)) return current;
  return `${current} ${next}`;
}

async function handleToolCalls(toolCall) {
  const functionResponses = [];
  for (const call of toolCall.functionCalls || []) {
    emit('onTool', call.name);
    try {
      const output = await api(`/api/tools/${encodeURIComponent(call.name)}`, {
        method: 'POST',
        body: { persona: v.persona, args: call.args || {}, utterance: v.lastUserText }
      });
      (output.actions || []).forEach((action) => {
        if (action.type === 'endSession') v.stopWhenTurnEnds = true;
        else emit('onAction', action);
      });
      functionResponses.push({ id: call.id, name: call.name, response: { result: output.result } });
    } catch (error) {
      functionResponses.push({ id: call.id, name: call.name, response: { error: error.message } });
    }
  }
  if (functionResponses.length && v.socket?.readyState === WebSocket.OPEN) {
    v.socket.send(JSON.stringify({ toolResponse: { functionResponses } }));
  }
}

function handleMessage(message, greeting) {
  if (message.error) {
    setStatus('error', message.error.message || 'The voice service returned an error.');
    return;
  }
  if (message.setupComplete) {
    v.sessionReady = true;
    startMicCapture();
    setStatus('listening');
    v.socket.send(JSON.stringify({ realtimeInput: { text: greeting } }));
  }
  const content = message.serverContent;
  if (content) {
    if (content.inputTranscription?.text) {
      v.userText = merge(v.userText, content.inputTranscription.text);
      v.lastUserText = v.userText;
      emit('onCaption', 'user', v.userText);
    }
    if (content.outputTranscription?.text) {
      v.modelText = merge(v.modelText, content.outputTranscription.text);
      emit('onCaption', 'agent', v.modelText);
    }
    if (content.interrupted) stopPlayback();
    (content.modelTurn?.parts || []).forEach((part) => {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/pcm')) playAudioChunk(part.inlineData.data, part.inlineData.mimeType);
    });
    if (content.turnComplete) {
      if (v.userText) emit('onTurn', 'user', v.userText);
      if (v.modelText) emit('onTurn', 'agent', v.modelText);
      v.userText = '';
      v.modelText = '';
      if (v.active && !v.playbackSources.size) setStatus('listening');
      if (v.stopWhenTurnEnds) {
        v.stopWhenTurnEnds = false;
        const remaining = Math.max(0, (v.nextPlaybackTime - (v.audioContext?.currentTime || 0)) * 1000);
        setTimeout(stopVoice, remaining + 200);
      }
    }
  }
  if (message.toolCall) handleToolCalls(message.toolCall);
}

export async function startVoice({ mode, roleId, hooks }) {
  if (v.active) stopVoice();
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    throw new Error('This browser does not support live voice. Use the latest Chrome or Edge.');
  }
  v.hooks = hooks || {};
  v.active = true;
  v.sessionReady = false;
  v.micChunks = [];
  v.micChunkLength = 0;
  v.userText = '';
  v.modelText = '';
  v.lastUserText = '';
  v.stopWhenTurnEnds = false;
  setStatus('connecting');

  try {
    v.audioStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    v.audioContext = new AudioContext();
    await v.audioContext.audioWorklet.addModule('/mic-processor.js');
    await v.audioContext.resume();
    const session = await api('/api/voice/session-token', { method: 'POST', body: { mode, roleId } });
    if (!v.active) return;
    v.persona = session.persona;
    v.socket = new WebSocket(`${LIVE_URL}?access_token=${encodeURIComponent(session.token)}`);
    v.socket.onopen = () => {
      const config = session.config;
      v.socket.send(JSON.stringify({
        setup: {
          model: `models/${session.model}`,
          generationConfig: { responseModalities: config.responseModalities, speechConfig: config.speechConfig },
          systemInstruction: config.systemInstruction,
          tools: config.tools,
          inputAudioTranscription: config.inputAudioTranscription,
          outputAudioTranscription: config.outputAudioTranscription,
          contextWindowCompression: config.contextWindowCompression
        }
      }));
    };
    v.socket.onmessage = async (event) => {
      try {
        const payload = event.data instanceof Blob ? await event.data.text() : event.data;
        handleMessage(JSON.parse(payload), session.greeting);
      } catch (error) {
        console.error('Could not process Live API message:', error);
      }
    };
    v.socket.onerror = () => setStatus('error', 'Voice connection failed. Check the server API key and try again.');
    v.socket.onclose = (event) => {
      if (v.active) {
        stopVoice();
        if (event.code !== 1000 && event.reason) setStatus('error', event.reason);
      }
    };
  } catch (error) {
    stopVoice();
    throw error.name === 'NotAllowedError' ? new Error('Microphone access was blocked. Allow it in the browser and try again.') : error;
  }
}

export function stopVoice() {
  const wasActive = v.active;
  v.active = false;
  const socket = v.socket;
  v.socket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  if (v.micNode) {
    v.micNode.port.onmessage = null;
    v.micNode.disconnect();
    v.micNode = null;
  }
  v.audioStream?.getTracks().forEach((track) => track.stop());
  v.audioStream = null;
  stopPlayback();
  v.audioContext?.close().catch(() => {});
  v.audioContext = null;
  v.sessionReady = false;
  if (wasActive) setStatus('idle');
}

export function sendVoiceText(text) {
  if (!v.sessionReady || v.socket?.readyState !== WebSocket.OPEN) return false;
  v.lastUserText = text;
  v.socket.send(JSON.stringify({ realtimeInput: { text } }));
  emit('onTurn', 'user', text);
  return true;
}
