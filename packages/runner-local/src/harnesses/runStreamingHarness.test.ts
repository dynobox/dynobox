import {describe, expect, it} from 'vitest';

import {ToolEventLineStream} from './runStreamingHarness.js';
import type {ToolEventLineStreamOptions} from './runStreamingHarness.js';
import type {ToolEvent} from './types.js';

function createStream(
  options: {
    shouldEmit?: (event: ToolEvent, line: string) => boolean;
  } = {},
): {
  events: ToolEvent[];
  lineNumbers: number[];
  lines: string[];
  stream: ToolEventLineStream;
} {
  const events: ToolEvent[] = [];
  const lineNumbers: number[] = [];
  const lines: string[] = [];
  const streamOptions: ToolEventLineStreamOptions = {
    parseLine: (line: string, lineNumber: number) => {
      lines.push(line);
      lineNumbers.push(lineNumber);
      if (line === 'throw') throw new Error('malformed line');
      return {
        toolEvents: [{kind: 'unknown', rawName: 'TestTool', input: line}],
      };
    },
    onToolEvent: (event: ToolEvent) => events.push(event),
    ...(options.shouldEmit === undefined
      ? {}
      : {shouldEmit: options.shouldEmit}),
  };

  return {
    events,
    lineNumbers,
    lines,
    stream: new ToolEventLineStream(streamOptions),
  };
}

describe('ToolEventLineStream', () => {
  it('buffers chunked lines and handles LF and CRLF delimiters', () => {
    const {events, lineNumbers, lines, stream} = createStream();

    stream.write(' first');
    stream.write(' line\nsecond line\r\n');

    expect(lines).toEqual(['first line', 'second line']);
    expect(lineNumbers).toEqual([1, 2]);
    expect(events.map((event) => event.input)).toEqual([
      'first line',
      'second line',
    ]);
  });

  it('flushes a final unterminated line once', () => {
    const {events, stream} = createStream();

    stream.write('final line');
    stream.flush();
    stream.flush();

    expect(events.map((event) => event.input)).toEqual(['final line']);
  });

  it('ignores blank lines and parse errors during streaming', () => {
    const {events, lineNumbers, lines, stream} = createStream();

    stream.write('\nthrow\nok\n');

    expect(lines).toEqual(['throw', 'ok']);
    expect(lineNumbers).toEqual([1, 2]);
    expect(events.map((event) => event.input)).toEqual(['ok']);
  });

  it('allows adapters to suppress emitted tool events', () => {
    const {events, stream} = createStream({
      shouldEmit: (event) => event.input !== 'duplicate',
    });

    stream.write('keep\nduplicate\n');

    expect(events.map((event) => event.input)).toEqual(['keep']);
  });
});
