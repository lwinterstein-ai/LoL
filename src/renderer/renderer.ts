export {};

type LeagueScoreboard = {
  players: LeagueScoreboardPlayer[];
};

type LeagueScoreboardPlayer = {
  name: string;
  champion: string;
  team: string;
  level: number | null;
  stats: LeagueScoreboardStats;
  items: LeagueScoreboardItem[];
};

type LeagueScoreboardStats = {
  maxHealth: number | null;
  attackDamage: number | null;
  abilityPower: number | null;
  armor: number | null;
  magicResist: number | null;
};

type LeagueScoreboardItem = {
  name: string;
  rawDisplay: string;
  itemId: number;
  count: number;
};

type WindowWithOverwolf = Window &
  typeof globalThis & {
    app: {
      initialize: () => void;
    };
    gep: {
      onMessage: (handler: (...args: any[]) => void) => void;
      onScoreboardUpdate: (handler: (payload: LeagueScoreboard) => void) => void;
      onScoreboardError: (handler: (payload: any) => void) => void;
      setRequiredFeature: () => Promise<void>;
      getInfo: () => Promise<any>;
    };
  };

let ddragonInitPromise: Promise<void> | null = null;
let ddragonVersion: string | null = null;
const championIdByName: Record<string, string> = {};

const statusEl = document.getElementById('status');
const blueTeamContainer = document.querySelector<HTMLElement>(
  'section[data-team="ORDER"] .players'
);
const redTeamContainer = document.querySelector<HTMLElement>(
  'section[data-team="CHAOS"] .players'
);

window.addEventListener('DOMContentLoaded', () => {
  const owWindow = window as WindowWithOverwolf;

  owWindow.app.initialize();

  if (statusEl) {
    statusEl.textContent = 'Waiting for live match dataâ€¦';
  }

  owWindow.gep.onMessage((...args: any[]) => {
    console.info('[GEP log]', ...args);
  });

  owWindow.gep.onScoreboardUpdate(async (payload: LeagueScoreboard) => {
    if (!payload?.players?.length) {
      updateStatus('Connected, waiting for players…');
      clearTeams();
      return;
    }

    await ensureDdragonMetadata();

    updateStatus('Live match detected.');
    renderTeam(blueTeamContainer, payload.players.filter(p => p.team === 'ORDER'));
    renderTeam(redTeamContainer, payload.players.filter(p => p.team === 'CHAOS'));
  });

  owWindow.gep.onScoreboardError((payload) => {
    const message = payload?.error ? String(payload.error) : 'Lost connection to League live data.';
    updateStatus(`${message} Retryingâ€¦ Make sure the Overwolf app stays open and League is running.`);
  });
});

function renderTeam(container: HTMLElement | null, players: LeagueScoreboardPlayer[]) {
  if (!container) {
    return;
  }

  if (!players.length) {
    container.innerHTML = `<p style="color:#64748b; font-size:13px; margin:0;">No players detected.</p>`;
    return;
  }

  container.innerHTML = players.map(renderPlayer).join('');
}

function renderPlayer(player: LeagueScoreboardPlayer): string {
  const championNameSafe = sanitize(player.champion || 'Unknown Champion');
  const summonerNameSafe = sanitize(player.name || 'Unknown Summoner');
  const championIconUrl = getChampionIconUrl(player.champion);
  const levelMarkup =
    player.level !== null && player.level !== undefined
      ? `<span class="champion-level">${sanitize(String(player.level))}</span>`
      : '';

  const championVisual = `
    <div class="champion-frame">
      ${
        championIconUrl
          ? `<img class="champion-art" src="${escapeAttribute(championIconUrl)}" alt="${championNameSafe}" loading="lazy" />`
          : `<div class="champion-placeholder">${sanitize(getChampionInitials(player.champion))}</div>`
      }
      ${levelMarkup}
    </div>
  `;

  const itemMultiplierSymbol = '×';
  const itemsMarkup = player.items.length
    ? player.items
        .map(item => {
          const label = item.count > 1 ? `${item.name} ${itemMultiplierSymbol}${item.count}` : item.name;
          const iconUrl = getItemIconUrl(item.itemId);
          const titleAttr = escapeAttribute(item.rawDisplay ?? label);
          const altAttr = escapeAttribute(label);

          if (iconUrl) {
            const stackMarkup = item.count > 1 ? `<span class="item-stack">${item.count}</span>` : '';
            return `<div class="item-icon" title="${titleAttr}">
              <img src="${escapeAttribute(iconUrl)}" alt="${altAttr}" loading="lazy" />
              ${stackMarkup}
            </div>`;
          }

          return `<span class="item-pill" title="${titleAttr}">${sanitize(label)}</span>`;
        })
        .join('')
    : `<div class="item-empty">No items</div>`;

  const statsEntries = [
    { label: 'HP', value: player.stats?.maxHealth },
    { label: 'AD', value: player.stats?.attackDamage },
    { label: 'AP', value: player.stats?.abilityPower },
    { label: 'Armor', value: player.stats?.armor },
    { label: 'MR', value: player.stats?.magicResist },
  ];

  const statsMarkup = statsEntries
    .map(stat => `
      <div class="stat">
        <span class="stat-label">${stat.label}</span>
        <span class="stat-value">${formatStat(stat.value)}</span>
      </div>
    `)
    .join('');

  return `
    <article class="player">
      <div class="player-meta">
        <span class="champion">${championNameSafe}</span>
        ${championVisual}
        <span class="summoner">${summonerNameSafe}</span>
      </div>
      <div class="items">
        ${itemsMarkup}
      </div>
      <div class="player-stats">
        ${statsMarkup}
      </div>
    </article>
  `;
}

async function ensureDdragonMetadata(): Promise<void> {
  if (ddragonVersion) {
    return;
  }
  if (ddragonInitPromise) {
    return ddragonInitPromise;
  }

  ddragonInitPromise = (async () => {
    try {
      const versionsResponse = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
      const versions = (await versionsResponse.json()) as string[];
      ddragonVersion = versions?.[0] ?? null;

      if (!ddragonVersion) {
        throw new Error('Failed to resolve Data Dragon version');
      }

      const championResponse = await fetch(
        `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/data/en_US/champion.json`
      );
      const championJson = await championResponse.json();
      const championData = (championJson?.data ?? {}) as Record<string, any>;

      Object.values(championData).forEach((champion: any) => {
        if (!champion?.name || !champion?.id) {
          return;
        }
        championIdByName[String(champion.name).toLowerCase()] = String(champion.id);
      });
    } catch (error) {
      console.error('Failed to bootstrap Data Dragon metadata', error);
      ddragonVersion = ddragonVersion ?? '14.20.1';
    }
  })();

  return ddragonInitPromise;
}

function getChampionIconUrl(championName: string): string | null {
  if (!championName) {
    return null;
  }

  const version = ddragonVersion;
  if (!version) {
    return null;
  }

  const normalized = championName.toLowerCase();
  const fallbackKey = championName.replace(/[^A-Za-z0-9]/g, '');
  const championKey = championIdByName[normalized] ?? fallbackKey;

  if (!championKey) {
    return null;
  }

  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${championKey}.png`;
}

function getItemIconUrl(itemId: number): string | null {
  if (!itemId || !ddragonVersion) {
    return null;
  }

  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${itemId}.png`;
}

function getChampionInitials(championName: string): string {
  const letters = (championName ?? '').replace(/[^A-Za-z]/g, '').slice(0, 2);
  return letters ? letters.toUpperCase() : '??';
}

function formatStat(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '--';
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '--';
  }

  return Math.round(numeric).toString();
}

function escapeAttribute(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitize(value: string): string {
  const div = document.createElement('div');
  div.innerText = value ?? '';
  return div.innerHTML;
}

function updateStatus(message: string) {
  if (statusEl) {
    statusEl.textContent = message;
  }
}

function clearTeams() {
  if (blueTeamContainer) {
    blueTeamContainer.innerHTML = '';
  }
  if (redTeamContainer) {
    redTeamContainer.innerHTML = '';
  }
}
