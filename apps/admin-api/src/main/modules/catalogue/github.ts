import { createPrivateKey, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { z } from 'zod';
import type { AppConfig } from '../../config/app-config.js';
import { HttpError } from '../../shared/http/errors.js';
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
export const PullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string().url(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: Sha.nullable(),
  head: z.object({
    sha: Sha,
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ ref: z.string() }),
});
export type Pull = z.infer<typeof PullSchema>;
export class Github {
  private cachedToken?: { token: string; expires: number };
  constructor(
    private readonly config: AppConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  get configured(): boolean {
    return Boolean(
      this.config.APP_GITHUB_APP_ID &&
        this.config.APP_GITHUB_INSTALLATION_ID &&
        this.config.APP_GITHUB_PRIVATE_KEY,
    );
  }
  get repo(): string {
    return this.config.APP_CATALOGUE_REPO;
  }
  get branch(): string {
    return this.config.APP_CATALOGUE_BRANCH;
  }
  private async token(): Promise<string> {
    if (!this.configured)
      throw new HttpError(
        503,
        'github_not_configured',
        'Configure the catalogue GitHub App in the API.',
      );
    if (this.cachedToken && this.cachedToken.expires > Date.now()) return this.cachedToken.token;
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.config.APP_GITHUB_APP_ID!)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 30)
      .setExpirationTime('5m')
      .sign(createPrivateKey(this.config.APP_GITHUB_PRIVATE_KEY!.replace(/\\n/g, '\n')));
    const response = await this.fetcher(
      `${this.config.APP_GITHUB_API_URL}/app/installations/${this.config.APP_GITHUB_INSTALLATION_ID}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repositories: [this.repo.split('/')[1]],
          permissions: { contents: 'write' },
        }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    );
    if (!response.ok)
      throw new HttpError(502, 'github_auth', 'The GitHub App could not authenticate.');
    const result = z
      .object({ token: z.string(), expires_at: z.string().datetime() })
      .parse(await response.json());
    this.cachedToken = { token: result.token, expires: Date.parse(result.expires_at) - 60000 };
    return result.token;
  }
  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await this.fetcher(
      `${this.config.APP_GITHUB_API_URL}/repos/${this.repo}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    );
    if (!response.ok)
      throw new HttpError(
        response.status === 404 ? 404 : [409, 422, 405].includes(response.status) ? 409 : 502,
        'github_request',
        response.status === 404
          ? 'GitHub resource not found.'
          : 'GitHub rejected the publication. Check the base revision and the application write permissions.',
      );
    return response.status === 204 ? undefined : await response.json();
  }
  async head(): Promise<string> {
    return z
      .object({ object: z.object({ sha: Sha }) })
      .parse(await this.request(`/git/ref/heads/${encodeURIComponent(this.branch)}`)).object.sha;
  }
  async file(path: string, ref: string): Promise<string> {
    const result = z
      .object({
        encoding: z.literal('base64'),
        content: z.string(),
        size: z.number().max(1_000_000),
      })
      .parse(await this.request(`/contents/${path}?ref=${encodeURIComponent(ref)}`));
    return Buffer.from(result.content, 'base64').toString('utf8');
  }
  async entries(path: string, ref: string): Promise<{ name: string; path: string }[]> {
    if (
      !/^environments\/identity\/(?:generated\/)?(?:revisions|contracts|operations|environments)(?:\/[a-zA-Z0-9_-]+)*$/.test(
        path,
      )
    )
      throw new HttpError(
        422,
        'invalid_directory',
        'The directory is outside the identity workflow.',
      );
    Sha.parse(ref);
    const entries = z
      .array(z.object({ name: z.string(), path: z.string(), type: z.enum(['file', 'dir']) }))
      .max(1000)
      .parse(await this.request(`/contents/${path}?ref=${encodeURIComponent(ref)}`));
    return entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => {
        if (!/^[a-zA-Z0-9_-]+\.yaml$/.test(entry.name) || entry.path !== `${path}/${entry.name}`)
          throw new HttpError(
            502,
            'invalid_directory_entry',
            'GitHub returned an invalid identity directory entry.',
          );
        return { name: entry.name, path: entry.path };
      });
  }
  async commit(
    baseSha: string,
    files: { path: string; content: string }[],
    message: string,
  ): Promise<{ sha: string; html_url: string }> {
    Sha.parse(baseSha);
    if (
      files.length === 0 ||
      files.length > 100 ||
      new Set(files.map((file) => file.path)).size !== files.length ||
      message.trim().length === 0 ||
      message.length > 2000 ||
      files.some(
        (file) =>
          !/^(?:environments\/identity\/(?:generated\/)?(?:revisions|contracts|operations|environments)\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.yaml|environments\/(?:local|staging|production)\/identity-(?:config-sync|account-api)\.yaml)$/.test(
            file.path,
          ) || Buffer.byteLength(file.content, 'utf8') > 1_000_000,
      ) ||
      files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0) > 5_000_000
    )
      throw new HttpError(
        422,
        'invalid_identity_commit',
        'The publication contains invalid identity files or content.',
      );
    if ((await this.head()) !== baseSha)
      throw new HttpError(
        409,
        'stale_catalogue',
        'The catalogue has changed. Reload before publishing.',
      );
    const parent = z
      .object({ tree: z.object({ sha: Sha }) })
      .parse(await this.request(`/git/commits/${baseSha}`));
    const tree = z.object({ sha: Sha }).parse(
      await this.request('/git/trees', 'POST', {
        base_tree: parent.tree.sha,
        tree: files.map((file) => ({ ...file, mode: '100644', type: 'blob' })),
      }),
    );
    const commit = z.object({ sha: Sha }).parse(
      await this.request('/git/commits', 'POST', {
        message,
        tree: tree.sha,
        parents: [baseSha],
      }),
    );
    // A concurrent writer creates a sibling commit: GitHub rejects this non-fast-forward update.
    await this.request(`/git/refs/heads/${encodeURIComponent(this.branch)}`, 'PATCH', {
      sha: commit.sha,
      force: false,
    });
    return { sha: commit.sha, html_url: `https://github.com/${this.repo}/commit/${commit.sha}` };
  }
  async pull(number: number): Promise<Pull> {
    const pull = PullSchema.parse(await this.request(`/pulls/${number}`));
    this.assertPull(pull);
    return pull;
  }
  assertPull(pull: Pull): void {
    if (
      !pull.head.ref.startsWith('identity-catalogue/') ||
      pull.head.repo?.full_name.toLowerCase() !== this.repo.toLowerCase() ||
      pull.base.ref !== this.branch
    )
      throw new HttpError(
        403,
        'foreign_pull',
        'The pull request is outside the identity workflow.',
      );
  }
  async pulls(): Promise<Pull[]> {
    return PullSchema.array()
      .parse(
        await this.request(`/pulls?state=all&base=${encodeURIComponent(this.branch)}&per_page=100`),
      )
      .filter(
        (pull) =>
          pull.head.ref.startsWith('identity-catalogue/') &&
          pull.head.repo?.full_name.toLowerCase() === this.repo.toLowerCase(),
      )
      .map((pull) => ({ ...pull, merged: Boolean(pull.merged_at) }));
  }
  async changedFiles(number: number): Promise<string[]> {
    return z
      .array(z.object({ filename: z.string() }))
      .max(10)
      .parse(await this.request(`/pulls/${number}/files?per_page=100`))
      .map((file) => file.filename);
  }
  async createPull(
    baseSha: string,
    files: { path: string; content: string }[],
    title: string,
    body: string,
  ): Promise<Pull> {
    if ((await this.head()) !== baseSha)
      throw new HttpError(
        409,
        'stale_catalogue',
        'The catalogue has changed. Reload and review your changes before publishing.',
      );
    const parent = z
      .object({ tree: z.object({ sha: Sha }) })
      .parse(await this.request(`/git/commits/${baseSha}`));
    const tree = z.object({ sha: Sha }).parse(
      await this.request('/git/trees', 'POST', {
        base_tree: parent.tree.sha,
        tree: files.map((file) => ({ ...file, mode: '100644', type: 'blob' })),
      }),
    );
    const commit = z.object({ sha: Sha }).parse(
      await this.request('/git/commits', 'POST', {
        message: title,
        tree: tree.sha,
        parents: [baseSha],
      }),
    );
    const branch = `identity-catalogue/${randomUUID()}`;
    await this.request('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha });
    // Branch remains recoverable if PR creation fails; no automatic duplicate submission.
    return PullSchema.parse(
      await this.request('/pulls', 'POST', { title, body, head: branch, base: this.branch }),
    );
  }
  async merge(number: number, headSha: string): Promise<unknown> {
    const pull = await this.pull(number);
    if (pull.head.sha !== headSha || pull.state !== 'open')
      throw new HttpError(409, 'stale_pull', 'The pull request has changed or is already closed.');
    return this.request(`/pulls/${number}/merge`, 'PUT', { sha: headSha, merge_method: 'squash' });
  }
}
