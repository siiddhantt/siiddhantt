import { mkdir, readFile, writeFile } from 'node:fs/promises';

const config = JSON.parse(
  await readFile(new URL('../profile.config.json', import.meta.url), 'utf8'),
);

const token = process.env.GITHUB_TOKEN || '';
const username = config.username;

const themes = {
  dark: {
    desktop: '#063f3f',
    chrome: '#303034',
    chromeLight: '#68686f',
    chromeMid: '#45454a',
    chromeDark: '#09090b',
    title: '#24205f',
    titleText: '#ffffff',
    panel: '#121214',
    text: '#f4f4f4',
    muted: '#b8b8bd',
    selection: '#35308a',
    selectionText: '#ffffff',
    folder: '#f0c75e',
    folderDark: '#987526',
    file: '#eeeeee',
    link: '#b8a6ff',
    monitor: '#43d17a',
  },
  light: {
    desktop: '#008080',
    chrome: '#c0c0c0',
    chromeLight: '#ffffff',
    chromeMid: '#dfdfdf',
    chromeDark: '#404040',
    title: '#000080',
    titleText: '#ffffff',
    panel: '#ffffff',
    text: '#000000',
    muted: '#4a4a4a',
    selection: '#000080',
    selectionText: '#ffffff',
    folder: '#f6d66b',
    folderDark: '#9b7824',
    file: '#ffffff',
    link: '#000080',
    monitor: '#008000',
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

async function githubGraphql(query, variables) {
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to fetch commit activity');
  }

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'User-Agent': username + '-profile-renderer',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (!response.ok || result.errors?.length) {
    const detail = result.errors?.map(error => error.message).join('; ');
    throw new Error(
      'GitHub GraphQL request failed: ' +
        (detail || 'HTTP ' + response.status),
    );
  }
  return result.data;
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

function recentMonthWindows(months = 6) {
  const now = new Date();
  return Array.from({ length: months }, (_, index) => {
    const from = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - index - 1), 1),
    );
    const to = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1) - 1,
    );
    return {
      label: new Intl.DateTimeFormat('en', {
        month: 'short',
        timeZone: 'UTC',
      }).format(from),
      from: from.toISOString(),
      to: to.toISOString(),
    };
  });
}

async function fetchCommitActivity(months = 6) {
  const windows = recentMonthWindows(months);
  const definitions = ['$login:String!'];
  const fields = [];
  const variables = { login: username };

  windows.forEach((window, index) => {
    definitions.push('$from' + index + ':DateTime!');
    definitions.push('$to' + index + ':DateTime!');
    fields.push(
      'm' +
        index +
        ':contributionsCollection(from:$from' +
        index +
        ',to:$to' +
        index +
        '){totalCommitContributions}',
    );
    variables['from' + index] = window.from;
    variables['to' + index] = window.to;
  });

  const query =
    'query(' +
    definitions.join(',') +
    '){user(login:$login){' +
    fields.join(' ') +
    '}}';
  const data = await githubGraphql(query, variables);
  return windows.map((window, index) => ({
    label: window.label,
    count: data.user['m' + index].totalCommitContributions,
  }));
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

function repoPathFromIssue(issue) {
  const apiMatch = String(issue?.repository_url || '').match(/\/repos\/([^/]+\/[^/]+)$/);
  if (apiMatch) return apiMatch[1];
  const webMatch = String(issue?.html_url || '').match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
  return webMatch?.[1] || 'open source';
}

async function fetchMergedPullRequests() {
  const query = encodeURIComponent(
    'is:pr is:merged is:public author:' + username,
  );
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

const [user, mergedSearch, commitActivity] = await Promise.all([
  github('/users/' + username),
  fetchMergedPullRequests(),
  fetchCommitActivity(),
]);

const externalMergedPullRequests = (mergedSearch.items || []).filter(
  issue =>
    !repoPathFromIssue(issue)
      .toLowerCase()
      .startsWith(username.toLowerCase() + '/'),
);
const latestMergedPr = externalMergedPullRequests[0] || null;
const contributedRepositories = new Set(
  externalMergedPullRequests
    .map(repoPathFromIssue)
);

const featuredWork = await Promise.all(
  config.featuredWork.map(async work => {
    const query =
      'is:pr is:merged author:' + username + ' repo:' + work.repo;
    const result = await github(
      '/search/issues?q=' + encodeURIComponent(query) + '&per_page=1',
    );
    return {
      ...work,
      count: result.total_count,
    };
  }),
);

const liveData = {
  user,
  contributedRepositories: contributedRepositories.size,
  mergedPullRequests: mergedSearch.total_count,
  latestMergedPr,
  latestMergedRepo: repoPathFromIssue(latestMergedPr),
  featuredWork,
  commitActivity,
};

function renderCard(data, colors) {
  const lines = [];
  const latestPrTitle = wrap(
    data.latestMergedPr?.title || 'Waiting for the next merged patch.',
    78,
  );
  const latestPrName =
    truncate(data.latestMergedRepo, 26) +
    ' #' +
    String(data.latestMergedPr?.number || '');

  const addBevel = (x, y, width, height, fill = colors.chrome) => {
    lines.push('  <rect x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '" fill="' + fill + '" class="pixel"/>');
    lines.push('  <path d="M' + (x + 1) + ' ' + (y + height - 1) + 'V' + (y + 1) + 'H' + (x + width - 1) + '" stroke="' + colors.chromeLight + '" stroke-width="3" fill="none" class="pixel"/>');
    lines.push('  <path d="M' + (x + width - 1) + ' ' + (y + 1) + 'V' + (y + height - 1) + 'H' + (x + 1) + '" stroke="' + colors.chromeDark + '" stroke-width="3" fill="none" class="pixel"/>');
  };

  const addInset = (x, y, width, height, fill = colors.panel) => {
    lines.push('  <rect x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '" fill="' + fill + '" class="pixel"/>');
    lines.push('  <path d="M' + (x + 1) + ' ' + (y + height - 1) + 'V' + (y + 1) + 'H' + (x + width - 1) + '" stroke="' + colors.chromeDark + '" stroke-width="3" fill="none" class="pixel"/>');
    lines.push('  <path d="M' + (x + width - 1) + ' ' + (y + 1) + 'V' + (y + height - 1) + 'H' + (x + 1) + '" stroke="' + colors.chromeLight + '" stroke-width="3" fill="none" class="pixel"/>');
  };

  const addFolder = (x, y) => {
    lines.push('  <g class="pixel">');
    lines.push('    <rect x="' + (x + 3) + '" y="' + y + '" width="11" height="6" fill="' + colors.folder + '" stroke="' + colors.folderDark + '"/>');
    lines.push('    <rect x="' + x + '" y="' + (y + 5) + '" width="25" height="18" fill="' + colors.folder + '" stroke="' + colors.folderDark + '"/>');
    lines.push('    <path d="M' + (x + 2) + ' ' + (y + 8) + 'H' + (x + 23) + '" stroke="' + colors.chromeLight + '"/>');
    lines.push('  </g>');
  };

  const addFile = (x, y) => {
    lines.push('  <g class="pixel">');
    lines.push('    <path d="M' + x + ' ' + y + 'H' + (x + 16) + 'L' + (x + 23) + ' ' + (y + 7) + 'V' + (y + 25) + 'H' + x + 'Z" fill="' + colors.file + '" stroke="' + colors.chromeDark + '"/>');
    lines.push('    <path d="M' + (x + 16) + ' ' + y + 'V' + (y + 7) + 'H' + (x + 23) + '" fill="none" stroke="' + colors.chromeDark + '"/>');
    lines.push('    <path d="M' + (x + 4) + ' ' + (y + 12) + 'H' + (x + 18) + 'M' + (x + 4) + ' ' + (y + 17) + 'H' + (x + 18) + '" stroke="#6b6b6b"/>');
    lines.push('  </g>');
  };

  const addToolbarButton = (x, label, icon) => {
    addBevel(x, 105, 92, 40);
    if (icon === 'back') {
      lines.push('  <path d="M' + (x + 14) + ' 125H' + (x + 31) + 'M' + (x + 14) + ' 125L' + (x + 23) + ' 116M' + (x + 14) + ' 125L' + (x + 23) + ' 134" stroke="' + colors.text + '" stroke-width="3" fill="none" class="pixel"/>');
    } else if (icon === 'up') {
      lines.push('  <path d="M' + (x + 22) + ' 135V116M' + (x + 22) + ' 116L' + (x + 14) + ' 124M' + (x + 22) + ' 116L' + (x + 30) + ' 124" stroke="' + colors.text + '" stroke-width="3" fill="none" class="pixel"/>');
    } else {
      lines.push('  <path d="M' + (x + 13) + ' 119H' + (x + 28) + 'V134H' + (x + 13) + 'ZM' + (x + 16) + ' 116H' + (x + 31) + 'V131" stroke="' + colors.text + '" stroke-width="2" fill="none" class="pixel"/>');
    }
    lines.push('  <text x="' + (x + 39) + '" y="132" fill="' + colors.text + '" class="ui" font-size="16">' + label + '</text>');
  };

  lines.push('<svg width="1200" height="660" viewBox="0 0 1200 660" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">');
  lines.push('  <title id="title">Live GitHub status for ' + escapeXml(username) + '</title>');
  lines.push('  <desc id="desc">A Windows 95 Explorer style view of repositories, merged pull requests, featured work, and recent open-source activity</desc>');
  lines.push('  <defs>');
  lines.push('    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">');
  lines.push('      <feDropShadow dx="7" dy="7" stdDeviation="0" flood-color="#000000" flood-opacity="0.35"/>');
  lines.push('    </filter>');
  lines.push('    <style>');
  lines.push('      .ui { font-family: Tahoma, MS Sans Serif, Arial, sans-serif; }');
  lines.push('      .mono { font-family: Courier New, Liberation Mono, monospace; }');
  lines.push('      .pixel { shape-rendering: crispEdges; }');
  lines.push('    </style>');
  lines.push('  </defs>');
  lines.push('  <rect width="1200" height="660" fill="' + colors.desktop + '"/>');
  lines.push('  <g filter="url(#shadow)">');
  addBevel(14, 14, 1172, 632);
  lines.push('  </g>');

  lines.push('  <rect x="21" y="21" width="1158" height="38" fill="' + colors.title + '" class="pixel"/>');
  lines.push('  <rect x="29" y="28" width="19" height="15" fill="' + colors.chromeMid + '" stroke="' + colors.titleText + '" class="pixel"/>');
  lines.push('  <rect x="34" y="44" width="19" height="5" fill="' + colors.chromeMid + '" stroke="' + colors.titleText + '" class="pixel"/>');
  lines.push('  <text x="61" y="48" fill="' + colors.titleText + '" class="ui" font-size="20" font-weight="700">GitHub Explorer - C:\\Users\\Siddhant</text>');

  [1080, 1112, 1144].forEach(x => addBevel(x, 26, 28, 27));
  lines.push('  <path d="M1087 45H1101" stroke="' + colors.text + '" stroke-width="3" class="pixel"/>');
  lines.push('  <rect x="1119" y="33" width="14" height="12" fill="none" stroke="' + colors.text + '" stroke-width="2" class="pixel"/>');
  lines.push('  <path d="M1151 33L1165 46M1165 33L1151 46" stroke="' + colors.text + '" stroke-width="2" class="pixel"/>');

  lines.push('  <text x="31" y="87" fill="' + colors.text + '" class="ui" font-size="17"><tspan text-decoration="underline">F</tspan>ile</text>');
  lines.push('  <text x="88" y="87" fill="' + colors.text + '" class="ui" font-size="17"><tspan text-decoration="underline">E</tspan>dit</text>');
  lines.push('  <text x="143" y="87" fill="' + colors.text + '" class="ui" font-size="17"><tspan text-decoration="underline">V</tspan>iew</text>');
  lines.push('  <text x="207" y="87" fill="' + colors.text + '" class="ui" font-size="17"><tspan text-decoration="underline">G</tspan>o</text>');
  lines.push('  <text x="254" y="87" fill="' + colors.text + '" class="ui" font-size="17"><tspan text-decoration="underline">H</tspan>elp</text>');
  lines.push('  <line x1="21" y1="96" x2="1179" y2="96" stroke="' + colors.chromeDark + '"/>');

  addToolbarButton(28, 'Back', 'back');
  addToolbarButton(126, 'Up', 'up');
  addToolbarButton(224, 'Open', 'open');
  lines.push('  <line x1="328" y1="106" x2="328" y2="144" stroke="' + colors.chromeDark + '"/>');
  lines.push('  <line x1="331" y1="106" x2="331" y2="144" stroke="' + colors.chromeLight + '"/>');
  addFolder(350, 113);
  lines.push('  <text x="386" y="133" fill="' + colors.text + '" class="ui" font-size="17">Featured Work</text>');

  lines.push('  <text x="30" y="179" fill="' + colors.text + '" class="ui" font-size="17">Address</text>');
  addInset(96, 153, 1075, 36);
  addFolder(105, 160);
  lines.push('  <text x="140" y="179" fill="' + colors.text + '" class="mono" font-size="17">github://siiddhantt/featured-work</text>');

  addInset(25, 196, 335, 382);
  addBevel(29, 200, 327, 36);
  lines.push('  <text x="43" y="225" fill="' + colors.text + '" class="ui" font-size="18" font-weight="700">Folders</text>');
  lines.push('  <rect x="34" y="246" width="317" height="42" fill="' + colors.selection + '" class="pixel"/>');
  lines.push('  <rect x="47" y="254" width="24" height="18" fill="' + colors.chromeMid + '" stroke="' + colors.selectionText + '" class="pixel"/>');
  lines.push('  <rect x="53" y="273" width="24" height="5" fill="' + colors.chromeMid + '" stroke="' + colors.selectionText + '" class="pixel"/>');
  lines.push('  <text x="89" y="276" fill="' + colors.selectionText + '" class="ui" font-size="19" font-weight="700">My GitHub</text>');

  const stats = [
    [compactNumber(data.user.public_repos), 'Public repositories'],
    [compactNumber(data.mergedPullRequests), 'Merged pull requests'],
    [compactNumber(data.contributedRepositories), 'External codebases'],
  ];
  stats.forEach((stat, index) => {
    const y = 326 + index * 42;
    lines.push('  <text x="48" y="' + y + '" fill="' + colors.link + '" class="ui" font-size="24" font-weight="700">' + escapeXml(stat[0]) + '</text>');
    lines.push('  <text x="102" y="' + y + '" fill="' + colors.text + '" class="ui" font-size="18">' + escapeXml(stat[1]) + '</text>');
  });
  lines.push('  <line x1="43" y1="435" x2="341" y2="435" stroke="' + colors.chromeMid + '"/>');
  lines.push('  <text x="46" y="463" fill="' + colors.text + '" class="ui" font-size="17" font-weight="700">Commit activity</text>');
  lines.push('  <text x="338" y="463" text-anchor="end" fill="' + colors.muted + '" class="ui" font-size="13">public / 6 months</text>');
  addInset(44, 474, 298, 77, colors.panel);
  [490, 507, 524, 541].forEach(y => {
    lines.push('  <line x1="49" y1="' + y + '" x2="337" y2="' + y + '" stroke="' + colors.chromeMid + '" stroke-opacity="0.55" class="pixel"/>');
  });
  const maxCommitCount = Math.max(
    1,
    ...data.commitActivity.map(month => month.count),
  );
  const commitPoints = data.commitActivity.map((month, index) => {
    const x = 60 + index * 53;
    const height = Math.round((month.count / maxCommitCount) * 49);
    return {
      x,
      y: 540 - height,
      ...month,
    };
  });
  commitPoints.forEach(point => {
    lines.push('  <line x1="' + point.x + '" y1="478" x2="' + point.x + '" y2="546" stroke="' + colors.chromeMid + '" stroke-opacity="0.4" class="pixel"/>');
  });
  lines.push('  <polyline points="' + commitPoints.map(point => point.x + ',' + point.y).join(' ') + '" fill="none" stroke="' + colors.monitor + '" stroke-width="3" stroke-linejoin="miter" stroke-linecap="square" class="pixel"/>');
  commitPoints.forEach(point => {
    lines.push('  <rect x="' + (point.x - 3) + '" y="' + (point.y - 3) + '" width="7" height="7" fill="' + colors.monitor + '" class="pixel"/>');
    lines.push('  <text x="' + point.x + '" y="' + Math.max(486, point.y - 7) + '" text-anchor="middle" fill="' + colors.text + '" class="ui" font-size="11">' + escapeXml(point.count) + '</text>');
    lines.push('  <text x="' + point.x + '" y="567" text-anchor="middle" fill="' + colors.muted + '" class="ui" font-size="12">' + escapeXml(point.label) + '</text>');
  });

  addInset(370, 196, 809, 382);
  addBevel(374, 200, 398, 36);
  addBevel(772, 200, 233, 36);
  addBevel(1005, 200, 170, 36);
  lines.push('  <text x="414" y="225" fill="' + colors.text + '" class="ui" font-size="17">Name</text>');
  lines.push('  <text x="790" y="225" fill="' + colors.text + '" class="ui" font-size="17">Focus</text>');
  lines.push('  <text x="1021" y="225" fill="' + colors.text + '" class="ui" font-size="17">Merged</text>');

  data.featuredWork.slice(0, 4).forEach((work, index) => {
    const y = 240 + index * 49;
    const selected = index === 0;
    const rowText = selected ? colors.selectionText : colors.text;
    if (selected) {
      lines.push('  <rect x="375" y="' + y + '" width="799" height="47" fill="' + colors.selection + '" class="pixel"/>');
    }
    addFolder(387, y + 11);
    lines.push('  <text x="424" y="' + (y + 31) + '" fill="' + rowText + '" class="ui" font-size="19" font-weight="700">' + escapeXml(work.label) + '</text>');
    lines.push('  <text x="790" y="' + (y + 31) + '" fill="' + rowText + '" class="ui" font-size="17">' + escapeXml(work.focus) + '</text>');
    lines.push('  <text x="1021" y="' + (y + 31) + '" fill="' + rowText + '" class="ui" font-size="16">' + escapeXml(work.count) + ' PRs</text>');
  });

  addInset(380, 447, 789, 121, colors.panel);
  lines.push('  <text x="396" y="472" fill="' + colors.muted + '" class="ui" font-size="14" font-weight="700">Latest merged patch</text>');
  lines.push('  <text x="396" y="499" fill="' + colors.link + '" class="ui" font-size="19" font-weight="700">' + escapeXml(latestPrName) + '</text>');
  lines.push('  <text x="1148" y="499" text-anchor="end" fill="' + colors.muted + '" class="ui" font-size="14">' + escapeXml(shortDate(data.latestMergedPr?.closed_at)) + '</text>');
  latestPrTitle.forEach((line, index) => {
    lines.push('  <text x="396" y="' + (526 + index * 21) + '" fill="' + colors.text + '" class="ui" font-size="16">' + escapeXml(line) + '</text>');
  });

  addInset(21, 585, 720, 52, colors.chrome);
  addInset(746, 585, 188, 52, colors.chrome);
  addInset(939, 585, 240, 52, colors.chrome);
  const featuredMergedPullRequests = data.featuredWork.reduce(
    (total, work) => total + work.count,
    0,
  );
  lines.push('  <text x="36" y="618" fill="' + colors.text + '" class="ui" font-size="16">4 featured repositories  |  ' + escapeXml(featuredMergedPullRequests) + ' merged pull requests</text>');
  lines.push('  <rect x="762" y="600" width="11" height="10" fill="' + colors.link + '" class="pixel"/>');
  lines.push('  <path d="M757 620V613H778V620" fill="' + colors.link + '" class="pixel"/>');
  lines.push('  <text x="788" y="618" fill="' + colors.text + '" class="ui" font-size="16">' + escapeXml(data.user.followers) + ' followers</text>');
  lines.push('  <text x="958" y="618" fill="' + colors.text + '" class="ui" font-size="16">github.com/' + escapeXml(username) + '</text>');
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
