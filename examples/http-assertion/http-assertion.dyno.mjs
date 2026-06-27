import {command, defineDyno, http} from '@dynobox/sdk';

export default defineDyno({
  name: 'http-assertion',
  harnesses: [{id: 'claude-code', permissionMode: 'default'}],
  endpoints: {
    getHttpBinStatus: http.endpoint({
      method: 'GET',
      url: 'https://httpbin.org/status/204',
    }),
    getHttpBinAnything: http.endpoint({
      method: 'GET',
      url: 'https://httpbin.org/anything',
    }),
  },
  scenarios: [
    {
      name: 'fetch expected endpoint',
      prompt:
        'Use curl to request https://httpbin.org/status/204, then report the status code.',
      assertions: [
        command.called('curl', {args: ['https://httpbin.org/status/204']}),
        http.called('getHttpBinStatus', {status: 204}),
      ],
    },
    {
      name: 'avoid unrelated endpoint',
      prompt:
        'Use curl to request https://httpbin.org/status/204. Do not request /anything.',
      assertions: [
        command.called('curl', {args: ['https://httpbin.org/status/204']}),
        http.called('getHttpBinStatus', {status: 204}),
        http.notCalled('getHttpBinAnything'),
      ],
    },
  ],
});
