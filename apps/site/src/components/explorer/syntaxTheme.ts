export const dynoboxSyntaxTheme = {
  name: 'dynobox-dark',
  type: 'dark' as const,
  colors: {
    'editor.background': '#050505',
    'editor.foreground': '#e6e7e2',
  },
  settings: [
    {
      settings: {
        foreground: '#e6e7e2',
      },
    },
    {
      scope: ['comment', 'punctuation.definition.comment'],
      settings: {
        foreground: '#92989d',
        fontStyle: 'italic',
      },
    },
    {
      scope: ['keyword', 'storage.type', 'storage.modifier'],
      settings: {
        foreground: '#e0897a',
      },
    },
    {
      scope: ['string', 'punctuation.definition.string'],
      settings: {
        foreground: '#9bba8b',
      },
    },
    {
      scope: [
        'entity.name.function',
        'entity.name.type',
        'entity.name.tag.yaml',
        'support.function',
        'support.type',
      ],
      settings: {
        foreground: '#93b0dc',
      },
    },
    {
      scope: ['constant.language', 'constant.numeric'],
      settings: {
        foreground: '#d5b37a',
      },
    },
  ],
};
