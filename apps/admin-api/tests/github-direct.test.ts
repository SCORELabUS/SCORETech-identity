import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/main/config/app-config.js';
import { Github } from '../src/main/modules/catalogue/github.js';
import { HttpError } from '../src/main/shared/http/errors.js';
const config = loadConfig({
  APP_CATALOGUE_BRANCH: 'main',
  APP_CORS_ORIGINS: 'http://localhost:5173',
  APP_KEYCLOAK_ISSUER: 'https://identity.example.test/realms/test',
  APP_KEYCLOAK_ADMIN_URL: 'http://identity:8080',
  APP_KEYCLOAK_REALM: 'test',
  APP_KEYCLOAK_ADMIN_CLIENT_SECRET: 'test',
});
const base = 'a'.repeat(40),
  next = 'b'.repeat(40),
  tree = 'c'.repeat(40);
const file = {
  path: `environments/identity/generated/revisions/staging/${next}.yaml`,
  content: 'realm: {}\n',
};
function fixture() {
  const github = new Github(config);
  const request = vi.spyOn(github, 'request').mockImplementation(async (path) => {
    if (path.startsWith('/git/ref/')) return { object: { sha: base } };
    if (path === `/git/commits/${base}`) return { tree: { sha: tree } };
    if (path === '/git/trees') return { sha: tree };
    if (path === '/git/commits') return { sha: next };
    return {};
  });
  return { github, request };
}
describe('direct identity publication', () => {
  it('checks the base before any mutation', async () => {
    const { github, request } = fixture();
    request.mockResolvedValueOnce({ object: { sha: next } });
    await expect(github.commit(base, [file], 'Publish identity')).rejects.toMatchObject({
      status: 409,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('writes one atomic commit and updates only by fast-forward', async () => {
    const { github, request } = fixture();
    const files = [
      file,
      { path: 'environments/staging/identity-config-sync.yaml', content: 'valueFiles: []' },
      { path: 'environments/staging/identity-account-api.yaml', content: 'valueFiles: []' },
    ];
    expect(await github.commit(base, files, 'Publish identity')).toEqual({
      sha: next,
      html_url: `https://github.com/${config.APP_CATALOGUE_REPO}/commit/${next}`,
    });
    expect(request).toHaveBeenCalledWith('/git/commits', 'POST', {
      message: 'Publish identity',
      tree,
      parents: [base],
    });
    expect(request).toHaveBeenLastCalledWith('/git/refs/heads/main', 'PATCH', {
      sha: next,
      force: false,
    });
    expect(request).toHaveBeenCalledWith('/git/trees', 'POST', {
      base_tree: tree,
      tree: files.map((entry) => ({ ...entry, mode: '100644', type: 'blob' })),
    });
  });
  it.each([
    'environments/production/secrets/admin.yaml',
    '.github/workflows/deploy.yaml',
    'environments/identity/revisions/../../secrets.yaml',
    '/environments/identity/revisions/a.yaml',
    'environments/identity/revisions/a.yml',
    'environments/development/identity-config-sync.yaml',
    'environments/identity/revisions/a.yaml?x=1',
    'environments/identity/revisions/a\\b.yaml',
  ])('rejects unsafe path %s before reading GitHub', async (path) => {
    const { github, request } = fixture();
    await expect(github.commit(base, [{ ...file, path }], 'Publish')).rejects.toMatchObject({
      status: 422,
    });
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects duplicate paths and unbounded content', async () => {
    const { github, request } = fixture();
    for (const files of [[], [file, file], [{ ...file, content: 'a'.repeat(1_000_001) }]])
      await expect(github.commit(base, files, 'Publish')).rejects.toMatchObject({ status: 422 });
    expect(request).not.toHaveBeenCalled();
  });
  it('propagates ref races without forcing or retrying the write', async () => {
    const { github, request } = fixture();
    request.mockImplementation(async (path, method) => {
      if (method === 'PATCH') throw new HttpError(409, 'github_request', 'Concurrent write');
      if (path.startsWith('/git/ref/')) return { object: { sha: base } };
      if (path === `/git/commits/${base}`) return { tree: { sha: tree } };
      return { sha: next };
    });
    await expect(github.commit(base, [file], 'Publish')).rejects.toMatchObject({ status: 409 });
    expect(request.mock.calls.filter((call) => call[1] === 'PATCH')).toHaveLength(1);
  });
});
describe('identity directory entries', () => {
  it('returns validated YAML files without descending into directories', async () => {
    const { github, request } = fixture();
    const path = 'environments/identity/generated/operations';
    request.mockResolvedValueOnce([
      { type: 'file', name: 'a.yaml', path: `${path}/a.yaml` },
      { type: 'dir', name: 'nested', path: `${path}/nested` },
    ]);
    expect(await github.entries(path, base)).toEqual([{ name: 'a.yaml', path: `${path}/a.yaml` }]);
  });
  it('rejects unsafe directory and mismatched provider paths', async () => {
    const { github, request } = fixture();
    await expect(
      github.entries('environments/identity/generated/operations/..', base),
    ).rejects.toMatchObject({ status: 422 });
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce([{ type: 'file', name: 'a.yaml', path: 'elsewhere/a.yaml' }]);
    await expect(github.entries('environments/identity/operations', base)).rejects.toMatchObject({
      status: 502,
    });
  });
});
