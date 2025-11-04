import { app as electronApp } from 'electron';
import { overwolf } from '@overwolf/ow-electron' // TODO: wil be @overwolf/ow-electron
import EventEmitter from 'events';
import https from 'https';
import { IncomingMessage } from 'http';
import { kGameIds } from '@overwolf/ow-electron-packages-types/game-list';

const app = electronApp as overwolf.OverwolfApp;

/**
 * Service used to register for Game Events,
 * receive games events, and then send them to a window for visual feedback
 *
 */
export class GameEventsService extends EventEmitter {
  private gepApi: overwolf.packages.OverwolfGameEventPackage;
  private activeGame = 0;
  private gepGamesId: number[] = [];
  private latestScoreboard: LeagueScoreboard | null = null;
  private leaguePollingTimer: NodeJS.Timeout | null = null;
  private lastScoreboardErrorTs = 0;
  private readonly httpsAgent = new https.Agent({ rejectUnauthorized: false });

  constructor() {
    super();
    this.registerOverwolfPackageManager();
  }


  /**
   *  for gep supported games goto:
   *  https://overwolf.github.io/api/electron/game-events/
   *   */
  public registerGames(gepGamesId: number[]) {
    this.emit('log', `register to game events for `, gepGamesId);
    this.gepGamesId = gepGamesId;
  }

  /**
   *
   */
  public async setRequiredFeaturesForAllSupportedGames() {
    await Promise.all(this.gepGamesId.map(async (gameId) => {
      const features = this.getRequiredFeatures(gameId);
      this.emit('log', `set-required-feature for: ${gameId}`, features ?? 'default');
      await this.gepApi.setRequiredFeatures(gameId, features);
    }));
  }

  /**
   *
   */
  public async getInfoForActiveGame(): Promise<any> {
    if (this.activeGame == 0) {
      return 'getInfo error - no active game';
    }

    return await this.gepApi.getInfo(this.activeGame);
  }

  /**
   * Register the Overwolf Package Manager events
   */
  private registerOverwolfPackageManager() {
    // Once a package is loaded
    app.overwolf.packages.on('ready', (e, packageName, version) => {
      // If this is the GEP package (packageName serves as a UID)
      if (packageName !== 'gep') {
        return;
      }

      this.emit('log', `gep package is ready: ${version}`);

      // Prepare for Game Event handling
      this.onGameEventsPackageReady();

      this.emit('ready');
    });
  }

  /**
   * Register listeners for the GEP Package once it is ready
   *
   * @param {overwolf.packages.OverwolfGameEventPackage} gep The GEP Package instance
   */
  private async onGameEventsPackageReady() {
    // Save package into private variable for later access
    this.gepApi = app.overwolf.packages.gep;

    // Remove all existing listeners to ensure a clean slate.
    // NOTE: If you have other classes listening on gep - they'll lose their
    // bindings.
    this.gepApi.removeAllListeners();

    // If a game is detected by the package
    // To check if the game is running in elevated mode, use `gameInfo.isElevate`
    this.gepApi.on('game-detected', (e, gameId, name, gameInfo) => {
      // If the game isn't in our tracking list

      if (!this.gepGamesId.includes(gameId)) {
        // Stops the GEP Package from connecting to the game
        this.emit('log', 'gep: skip game-detected', gameId, name, gameInfo.pid);
        return;
      }

      /// if (gameInfo.isElevated) {
      //   // Show message to User?
      //   return;
      // }

      this.emit('log', 'gep: register game-detected', gameId, name, gameInfo);
      e.enable();
      this.activeGame = gameId;
      if (gameId === kGameIds.LeagueofLegends) {
        this.startLeaguePolling();
      }

      // in order to start receiving event/info
      // setRequiredFeatures should be set
      const features = this.getRequiredFeatures(gameId);
      if (features) {
        this.gepApi.setRequiredFeatures(gameId, features).catch(error => {
          this.emit('log', 'set-required-features-error', gameId, error);
        });
      }
    });

    // undocumented (will add it fir next version) event to track game-exit
    // from the gep api
    //@ts-ignore
    this.gepApi.on('game-exit',(e, gameId, processName, pid) => {
      console.log('gep game exit', gameId, processName, pid);
      if (this.activeGame === gameId) {
        this.activeGame = 0;
      }
      if (gameId === kGameIds.LeagueofLegends) {
        this.stopLeaguePolling();
        this.latestScoreboard = null;
      }
    });

    // If a game is detected running in elevated mode
    // **Note** - This fires AFTER `game-detected`
    this.gepApi.on('elevated-privileges-required', (e, gameId, ...args) => {
      this.emit('log',
        'elevated-privileges-required',
        gameId,
        ...args
      );

      // TODO Handle case of Game running in elevated mode (meaning that the app also needs to run in elevated mode in order to detect events)
    });

    // When a new Info Update is fired
    this.gepApi.on('new-info-update', (e, gameId, ...args) => {
      this.emit('log', 'info-update', gameId, ...args);
      if (gameId === kGameIds.LeagueofLegends) {
        this.handleLeagueInfoUpdate(args[0]);
      }
    });

    // When a new Game Event is fired
    this.gepApi.on('new-game-event', (e, gameId, ...args) => {
      this.emit('log', 'new-event', gameId, ...args);
    });

    // If GEP encounters an error
    this.gepApi.on('error', (e, gameId, error, ...args) => {
      this.emit('log', 'gep-error', gameId, error, ...args);

      if (gameId === kGameIds.LeagueofLegends) {
        this.startLeaguePolling(true);
      }
      if (gameId === kGameIds.LeagueofLegends) {
        const normalizedError =
          typeof error === 'object' && error && 'message' in error
            ? (error as any).message
            : error || 'unknown-error';

        this.emit('scoreboard-error', {
          gameId,
          error: normalizedError,
          details: args
        });
      }
      if (this.activeGame === gameId) {
        this.activeGame = 0;
      }
    });

    this.setRequiredFeaturesForAllSupportedGames().catch((error) => {
      this.emit('log', 'set-required-features-error-init', error);
    });
  }

  private getRequiredFeatures(gameId: number): string[] | null {
    if (gameId === kGameIds.LeagueofLegends) {
      return ['live_client_data'];
    }

    return null;
  }

  private handleLeagueInfoUpdate(info: any) {
    if (!info) {
      return;
    }
    // GEP successfully provided data, no need to rely solely on polling
    this.startLeaguePolling();

    const liveClientData = info.live_client_data ?? info.info?.live_client_data;
    const allPlayers = liveClientData?.allPlayers;
    if (!Array.isArray(allPlayers)) {
      return;
    }

    const scoreboard: LeagueScoreboard = {
      players: allPlayers.map((player: any) => this.mapLeaguePlayer(player)),
    };

    const changed = JSON.stringify(scoreboard) !== JSON.stringify(this.latestScoreboard);
    this.latestScoreboard = scoreboard;
    if (changed) {
      this.emit('scoreboard-update', scoreboard);
    }
  }

  private mapLeaguePlayer(player: any): LeagueScoreboardPlayer {
    const rawItems: any[] = Array.isArray(player?.items) ? player.items : [];
    const statsSource =
      player?.championStats ??
      player?.champion_stats ??
      player?.stats ??
      player?.rawStats ??
      {};

    return {
      name: player?.summonerName ?? 'Unknown',
      champion: player?.championName ?? '',
      team: player?.team ?? 'ORDER',
      level: this.normalizeStat(player?.level ?? statsSource?.level),
      stats: {
        maxHealth: this.normalizeStat(statsSource?.maxHealth ?? statsSource?.hp),
        attackDamage: this.normalizeStat(statsSource?.attackDamage ?? statsSource?.ad),
        abilityPower: this.normalizeStat(statsSource?.abilityPower ?? statsSource?.ap),
        armor: this.normalizeStat(statsSource?.armor),
        magicResist: this.normalizeStat(
          statsSource?.magicResist ?? statsSource?.magicResistance ?? statsSource?.mr
        ),
      },
      items: rawItems
        .filter(item => item)
        .map(item => ({
          name: item?.displayName ?? 'Unknown Item',
          rawDisplay: item?.displayName ?? '',
          itemId: item?.itemID ?? 0,
          count: item?.count ?? 1,
        })),
    };
  }

  private normalizeStat(value: any): number | null {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return null;
    }
    return Math.round(num);
  }

  private startLeaguePolling(force = false) {
    if (this.leaguePollingTimer) {
      return;
    }
    if (!force && this.activeGame !== kGameIds.LeagueofLegends) {
      return;
    }

    const pollLeague = async () => {
      if (this.activeGame !== kGameIds.LeagueofLegends) {
        return;
      }
      try {
        const players = await this.fetchLeagueLiveClientPlayers();
        if (!Array.isArray(players)) {
          throw new Error('Invalid live client response');
        }
        const scoreboard: LeagueScoreboard = {
          players: players.map((player: any) => this.mapLeaguePlayer(player)),
        };

        const changed = JSON.stringify(scoreboard) !== JSON.stringify(this.latestScoreboard);
        this.latestScoreboard = scoreboard;
        if (changed) {
          this.emit('scoreboard-update', scoreboard);
        }
        this.lastScoreboardErrorTs = 0;
      } catch (error) {
        this.emit('log', 'league-live-client-error', (error as Error)?.message ?? error);
        if (Date.now() - this.lastScoreboardErrorTs > 5000) {
          this.lastScoreboardErrorTs = Date.now();
          this.emit('scoreboard-error', {
            gameId: kGameIds.LeagueofLegends,
            error: (error as Error)?.message ?? error ?? 'league-live-client-error',
          });
        }
      }
    };

    pollLeague();
    this.leaguePollingTimer = setInterval(pollLeague, 2000);
  }

  private stopLeaguePolling() {
    if (this.leaguePollingTimer) {
      clearInterval(this.leaguePollingTimer);
      this.leaguePollingTimer = null;
    }
  }

  private fetchLeagueLiveClientPlayers(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const request = https.get(
        {
          host: '127.0.0.1',
          port: 2999,
          path: '/liveclientdata/playerlist',
          agent: this.httpsAgent,
        },
        (response: IncomingMessage) => this.handleLiveClientResponse(response, resolve, reject)
      );

      request.on('error', (err) => reject(err));
      request.end();
    });
  }

  private handleLiveClientResponse(
    response: IncomingMessage,
    resolve: (value: any[]) => void,
    reject: (reason?: any) => void
  ) {
    const chunks: Uint8Array[] = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`live client http ${response.statusCode}`));
        return;
      }
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        resolve(payload);
      } catch (error) {
        reject(error);
      }
    });
  }
}

type LeagueScoreboardPlayer = {
  name: string;
  champion: string;
  team: string;
  level: number | null;
  stats: {
    maxHealth: number | null;
    attackDamage: number | null;
    abilityPower: number | null;
    armor: number | null;
    magicResist: number | null;
  };
  items: {
    name: string;
    rawDisplay: string;
    itemId: number;
    count: number;
  }[];
};

type LeagueScoreboard = {
  players: LeagueScoreboardPlayer[];
};
