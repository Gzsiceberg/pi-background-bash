import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

export default function (pi) {
  const provider = 'bg-fixture';
  const api = 'bg-fixture-api';
  let requests = 0;
  pi.registerProvider(provider, {
    name: 'Background job test fixture',
    baseUrl: 'http://localhost:0',
    apiKey: 'unused-test-key',
    api,
    models: [{
      id: 'scripted', name: 'Scripted', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000, maxTokens: 1024,
    }],
    streamSimple(model, context) {
      const toolCall = {
        type: 'toolCall', id: 'test-bg-run', name: 'bg_run',
        arguments: {
          name: 'Fixture build',
          command: "printf 'fixture live marker\\n'; while [[ ! -f proceed ]]; do sleep 0.02; done; printf 'fixture output\\n'",
          timeoutSeconds: 8,
        },
      };
      const isFirst = ++requests === 1;
      const notification = context.messages.some((message) => message.role === 'user' &&
        JSON.stringify(message.content).includes('<background-task-notification>'));
      const text = notification ? 'Fixture follow-up' : 'Fixture initial reply';
      const message = {
        role: 'assistant', api, provider, model: model.id, timestamp: Date.now(),
        content: isFirst ? [toolCall] : [{ type: 'text', text }],
        stopReason: isFirst ? 'toolUse' : 'stop',
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end(message);
      return stream;
    },
  });
}
