import { describe, expect, it } from 'vitest';
import { chatStream } from '../src/llm';

describe('chatStream', () => {
  it('parses fragmented SSE events and a final event without a trailing newline', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]',
    ];
    const fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    const output: string[] = [];
    for await (const delta of chatStream(fetch, { baseUrl: 'https://api.example/v1', apiKey: '', model: 'test' }, [])) output.push(delta);
    expect(output.join('')).toBe('Hello world');
  });
});
