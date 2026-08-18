import { mkdir, readFile, writeFile } from 'node:fs/promises';

const config = JSON.parse(
  await readFile(new URL('../profile.config.json', import.meta.url), 'utf8'),
);

const token = process.env.GITHUB_TOKEN || '';
const openRouterKey = process.env.OPENROUTER_API_KEY || '';
const username = config.username;

const themes = {
  dark: {
    background: '#0d1117',
    panel: '#161b22',
    panelAlt: '#111821',
    text: '#f0f6fc',
    muted: '#8b949e',
    border: '#30363d',
    accent: '#64ffda',
    accentSoft: '#2ea88f',
    purple: '#d2a8ff',
    blue: '#79c0ff',
  },
  light: {
    background: '#f6f8fa',
    panel: '#ffffff',
    panelAlt: '#f3f7f8',
    text: '#1f2328',
    muted: '#656d76',
    border: '#d0d7de',
    accent: '#00896f',
    accentSoft: '#40b69e',
    purple: '#8250df',
    blue: '#0969da',
  },
};

async function github(path) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': username + '-profile-renderer',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (token) {
    headers.Authorization = 'Bearer ' + token;
  }

  const response = await fetch('https://api.github.com' + path, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error('GitHub API request failed (' + response.status + '): ' + body.slice(0, 180));
  }
  return response.json();
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function compactNumber(value) {
  return new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
}

function shortDate(value) {
  if (!value) return 'recently';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function truncate(value, limit) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return clean.slice(0, Math.max(0, limit - 3)).trimEnd() + '...';
}

function wrap(value, lineLength, maxLines = 2) {
  let remaining = String(value ?? '').replace(/\s+/g, ' ').trim();
  const lines = [];

  while (remaining && lines.length < maxLines) {
    if (remaining.length <= lineLength) {
      lines.push(remaining);
      break;
    }

    if (lines.length === maxLines - 1) {
      lines.push(truncate(remaining, lineLength));
      break;
    }

    const breakpoint = remaining.lastIndexOf(' ', lineLength);
    const end = breakpoint > 0 ? breakpoint : lineLength;
    lines.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  return lines;
}

function currentIsoWeek() {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return date.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

function cleanRouletteText(value) {
  const clean = String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .trim();
  return clean.length >= 12 ? truncate(clean, 100) : '';
}

async function readRepoRouletteCache() {
  try {
    return JSON.parse(
      await readFile(new URL('../assets/repo-roulette.json', import.meta.url), 'utf8'),
    );
  } catch {
    return { period: '', text: '', model: '' };
  }
}

async function fetchRepoRoulette(repositories) {
  const cache = await readRepoRouletteCache();
  const period = currentIsoWeek();
  if (cache.period === period && cache.text) return cache;
  if (!openRouterKey) return cache.text ? cache : null;

  const projectData = repositories.slice(0, 12).map(repo => ({
    name: repo.name,
    language: repo.language || 'mixed',
    description: repo.description || '',
    topics: repo.topics || [],
  }));

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + openRouterKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/' + username,
        'X-Title': username + ' profile repo roulette',
      },
      body: JSON.stringify({
        model: 'openrouter/free',
        temperature: 0.8,
        max_tokens: 80,
        messages: [
          {
            role: 'system',
            content:
              'Create one technically coherent weekend project idea by combining two concepts from the supplied repositories. Prefer an underrepresented technology such as Go, WebAssembly, eBPF, or NATS when it fits. Return one sentence under 100 characters. No emoji, hype, metaphors, quotes, recruitment language, or Unicode dash characters.',
          },
          {
            role: 'user',
            content: 'Repository data:\n' + JSON.stringify(projectData),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error('OpenRouter request failed with HTTP ' + response.status);
    }

    const result = await response.json();
    const text = cleanRouletteText(result.choices?.[0]?.message?.content);
    if (!text) throw new Error('OpenRouter returned an empty repo roulette idea');

    const next = {
      period,
      text,
      model: String(result.model || 'openrouter/free'),
    };
    await mkdir(new URL('../assets/', import.meta.url), { recursive: true });
    await writeFile(
      new URL('../assets/repo-roulette.json', import.meta.url),
      JSON.stringify(next, null, 2) + '\n',
      'utf8',
    );
    return next;
  } catch (error) {
    console.warn('Repo roulette skipped: ' + error.message);
    return cache.text ? cache : null;
  }
}

function repoPathFromIssue(issue) {
  const apiMatch = String(issue?.repository_url || '').match(/\/repos\/([^/]+\/[^/]+)$/);
  if (apiMatch) return apiMatch[1];
  const webMatch = String(issue?.html_url || '').match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
  return webMatch?.[1] || 'open source';
}

async function fetchMergedPullRequests() {
  const query = encodeURIComponent('is:pr is:merged author:' + username);
  const firstPage = await github(
    '/search/issues?q=' + query + '&sort=updated&order=desc&per_page=100&page=1',
  );
  const items = [...(firstPage.items || [])];
  const pages = Math.min(10, Math.ceil(firstPage.total_count / 100));

  for (let page = 2; page <= pages; page += 1) {
    const result = await github(
      '/search/issues?q=' +
        query +
        '&sort=updated&order=desc&per_page=100&page=' +
        page,
    );
    items.push(...(result.items || []));
  }

  return {
    total_count: firstPage.total_count,
    items,
  };
}

const [user, repositories, mergedSearch] = await Promise.all([
  github('/users/' + username),
  github('/users/' + username + '/repos?per_page=100&sort=pushed&direction=desc'),
  fetchMergedPullRequests(),
]);

const ownedRepositories = repositories
  .filter(repo => !repo.fork && !repo.archived && repo.name !== username)
  .sort((left, right) => new Date(right.pushed_at) - new Date(left.pushed_at));

const latestRepository = ownedRepositories[0] || null;
const latestMergedPr = mergedSearch.items?.[0] || null;
const contributedRepositories = new Set(
  mergedSearch.items
    .map(repoPathFromIssue)
    .filter(repo => !repo.toLowerCase().startsWith(username.toLowerCase() + '/')),
);

const featuredProjects = await Promise.all(
  config.featuredProjects.map(async project => ({
    ...(await github('/repos/' + username + '/' + project.repo)),
    profileTagline: project.tagline,
  })),
);

const contributionSignals = await Promise.all(
  config.contributionRepos.map(async contribution => {
    const query =
      'is:pr is:merged author:' + username + ' repo:' + contribution.repo;
    const result = await github(
      '/search/issues?q=' + encodeURIComponent(query) + '&per_page=1',
    );
    return {
      label: contribution.label,
      count: result.total_count,
    };
  }),
);

const repoRoulette = await fetchRepoRoulette(ownedRepositories);

const liveData = {
  user,
  contributedRepositories: contributedRepositories.size,
  mergedPullRequests: mergedSearch.total_count,
  latestRepository,
  latestMergedPr,
  latestMergedRepo: repoPathFromIssue(latestMergedPr),
  featuredProjects,
  contributionSignals,
  repoRoulette,
};

function renderCard(data, colors) {
  const lines = [];
  const statValues = [
    ['PUBLIC REPOS', compactNumber(data.user.public_repos)],
    ['FOLLOWERS', compactNumber(data.user.followers)],
    ['CONTRIB REPOS', compactNumber(data.contributedRepositories)],
    ['MERGED PRS', compactNumber(data.mergedPullRequests)],
  ];

  lines.push('<svg width="1200" height="620" viewBox="0 0 1200 620" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">');
  lines.push('  <title id="title">Live GitHub status for ' + escapeXml(username) + '</title>');
  lines.push('  <desc id="desc">GitHub repositories, pull requests, featured projects, and open-source activity generated from live data</desc>');
  lines.push('  <defs>');
  lines.push('    <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" stroke="' + colors.border + '" stroke-opacity="0.28"/></pattern>');
  lines.push('    <linearGradient id="beam" x1="0" y1="0" x2="1200" y2="0"><stop stop-color="' + colors.accent + '" stop-opacity="0"/><stop offset="0.5" stop-color="' + colors.accent + '" stop-opacity="0.8"/><stop offset="1" stop-color="' + colors.accent + '" stop-opacity="0"/></linearGradient>');
  lines.push('    <style>');
  lines.push('      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }');
  lines.push('      .pulse { animation: pulse 2.5s ease-in-out infinite; }');
  lines.push('      .scan { animation: scan 7s linear infinite; }');
  lines.push('      @keyframes pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }');
  lines.push('      @keyframes scan { from { transform: translateX(-500px); } to { transform: translateX(500px); } }');
  lines.push('    </style>');
  lines.push('  </defs>');
  lines.push('  <rect x="1" y="1" width="1198" height="618" rx="22" fill="' + colors.background + '" stroke="' + colors.border + '" stroke-width="2"/>');
  lines.push('  <rect x="1" y="1" width="1198" height="618" rx="22" fill="url(#grid)"/>');
  lines.push('  <rect x="0" y="76" width="1200" height="2" fill="url(#beam)" class="scan"/>');
  lines.push('  <g class="mono">');
  lines.push('    <circle cx="43" cy="42" r="6" fill="' + colors.accent + '" class="pulse"/>');
  lines.push('    <text x="62" y="49" fill="' + colors.text + '" font-size="22" font-weight="700">s1d@github:~$ ./live-status</text>');
  lines.push('    <text x="1158" y="48" text-anchor="end" fill="' + colors.muted + '" font-size="13">AUTO REFRESH // ONLINE</text>');

  statValues.forEach((stat, index) => {
    const x = 42 + index * 282;
    lines.push('    <g transform="translate(' + x + ' 101)">');
    lines.push('      <rect width="264" height="70" rx="12" fill="' + colors.panel + '" stroke="' + colors.border + '"/>');
    lines.push('      <text x="18" y="27" fill="' + colors.muted + '" font-size="12" letter-spacing="1.4">' + stat[0] + '</text>');
    lines.push('      <text x="18" y="55" fill="' + colors.accent + '" font-size="24" font-weight="800">' + stat[1] + '</text>');
    lines.push('      <rect x="230" y="18" width="16" height="34" rx="4" fill="' + colors.accent + '" fill-opacity="0.12"/>');
    lines.push('      <rect x="234" y="22" width="8" height="26" rx="2" fill="' + colors.accent + '" class="pulse"/>');
    lines.push('    </g>');
  });

  const latestDescription = wrap(
    data.latestRepository?.description || 'The latest thing being assembled in public.',
    61,
  );
  lines.push('    <g transform="translate(42 194)">');
  lines.push('      <rect width="546" height="132" rx="14" fill="' + colors.panel + '" stroke="' + colors.border + '"/>');
  lines.push('      <text x="20" y="29" fill="' + colors.purple + '" font-size="12" font-weight="700" letter-spacing="1.4">LATEST SHIP</text>');
  lines.push('      <text x="20" y="60" fill="' + colors.text + '" font-size="23" font-weight="800">' + escapeXml(data.latestRepository?.name || 'loading') + '</text>');
  latestDescription.forEach((line, index) => {
    lines.push('      <text x="20" y="' + (86 + index * 19) + '" fill="' + colors.muted + '" font-size="14">' + escapeXml(line) + '</text>');
  });
  lines.push('      <text x="518" y="29" text-anchor="end" fill="' + colors.muted + '" font-size="11">' + escapeXml(shortDate(data.latestRepository?.pushed_at)) + '</text>');
  lines.push('    </g>');

  const prTitle = wrap(data.latestMergedPr?.title || 'Waiting for the next merged patch.', 61);
  lines.push('    <g transform="translate(612 194)">');
  lines.push('      <rect width="546" height="132" rx="14" fill="' + colors.panel + '" stroke="' + colors.border + '"/>');
  lines.push('      <text x="20" y="29" fill="' + colors.blue + '" font-size="12" font-weight="700" letter-spacing="1.4">LATEST MERGED PATCH</text>');
  lines.push('      <text x="20" y="58" fill="' + colors.text + '" font-size="18" font-weight="800">' + escapeXml(data.latestMergedRepo) + ' #' + escapeXml(data.latestMergedPr?.number || '') + '</text>');
  prTitle.forEach((line, index) => {
    lines.push('      <text x="20" y="' + (86 + index * 19) + '" fill="' + colors.muted + '" font-size="14">' + escapeXml(line) + '</text>');
  });
  lines.push('    </g>');

  data.featuredProjects.slice(0, 3).forEach((project, index) => {
    const x = 42 + index * 384;
    const projectLines = wrap(
      project.profileTagline || project.description || 'A system being built in public.',
      40,
    );
    lines.push('    <g transform="translate(' + x + ' 351)">');
    lines.push('      <rect width="348" height="146" rx="14" fill="' + colors.panelAlt + '" stroke="' + colors.border + '"/>');
    lines.push('      <text x="18" y="30" fill="' + colors.muted + '" font-size="11" letter-spacing="1.2">FEATURED // ' + escapeXml(project.language || 'CODE') + '</text>');
    lines.push('      <text x="18" y="63" fill="' + colors.text + '" font-size="21" font-weight="800">' + escapeXml(project.name) + '</text>');
    projectLines.forEach((line, lineIndex) => {
      lines.push('      <text x="18" y="' + (91 + lineIndex * 18) + '" fill="' + colors.muted + '" font-size="13">' + escapeXml(line) + '</text>');
    });
    lines.push('      <text x="330" y="30" text-anchor="end" fill="' + colors.accent + '" font-size="12">★ ' + compactNumber(project.stargazers_count) + '</text>');
    lines.push('    </g>');
  });

  const signalText = data.contributionSignals
    .map(signal => signal.label + ':' + signal.count)
    .join('  //  ');
  lines.push('    <text x="42" y="542" fill="' + colors.accent + '" font-size="13" font-weight="700" letter-spacing="0.8">OSS SIGNAL</text>');
  lines.push('    <text x="152" y="542" fill="' + colors.text + '" font-size="14">' + escapeXml(signalText) + '</text>');
  lines.push('    <line x1="42" y1="560" x2="1158" y2="560" stroke="' + colors.border + '"/>');

  if (data.repoRoulette?.text) {
    const rouletteModel = String(data.repoRoulette.model || 'openrouter/free')
      .split('/')
      .pop()
      .replace(':free', '');
    lines.push('    <text x="42" y="591" fill="' + colors.purple + '" font-size="12" font-weight="700" letter-spacing="1.1">REPO ROULETTE</text>');
    lines.push('    <text x="166" y="591" fill="' + colors.muted + '" font-size="13">' + escapeXml(truncate(data.repoRoulette.text, 88)) + '</text>');
    lines.push('    <text x="1158" y="591" text-anchor="end" fill="' + colors.muted + '" font-size="10">via ' + escapeXml(rouletteModel) + '</text>');
  } else {
    lines.push('    <text x="42" y="591" fill="' + colors.purple + '" font-size="12" font-weight="700" letter-spacing="1.1">PROFILE PIPELINE</text>');
    lines.push('    <text x="176" y="591" fill="' + colors.muted + '" font-size="12">public GitHub data // self-hosted SVG // no external stat-card service</text>');
  }
  lines.push('  </g>');
  lines.push('</svg>');
  return lines.join('\n') + '\n';
}

await mkdir(new URL('../assets/', import.meta.url), { recursive: true });
await Promise.all(
  Object.entries(themes).map(([name, colors]) =>
    writeFile(
      new URL('../assets/live-' + name + '.svg', import.meta.url),
      renderCard(liveData, colors),
      'utf8',
    ),
  ),
);

console.log(
  'Rendered profile cards for ' +
    username +
    ': ' +
    liveData.mergedPullRequests +
    ' merged PRs, ' +
    user.public_repos +
    ' public repos.',
);
