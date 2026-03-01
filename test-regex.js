const content = `hoistPattern:
  - '*'
ignoredBuilds:
  - esbuild
  - sharp
included:
  dependencies: true`;
const match = content.match(/ignoredBuilds:\n((?:  - .+\n?)*)/);
if (match && match[1]) {
  const ignored = match[1]
    .split('\n')
    .map(line => line.trim().replace(/^- /, ''))
    .filter(Boolean);
  console.log(ignored);
} else {
  console.log('no match');
}
