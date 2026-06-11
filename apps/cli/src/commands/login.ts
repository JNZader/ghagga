/**
 * Login command — authenticates with GitHub via Device Flow.
 *
 * Opens the browser to github.com/login/device, shows the user code,
 * and polls until the user authorizes. Saves the token to config.
 */

import { loadConfig, saveConfig } from '../lib/config.js';
import { fetchGitHubUser, pollForAccessToken, requestDeviceCode } from '../lib/oauth.js';
import * as tui from '../ui/tui.js';

/**
 * Try to open a URL in the default browser.
 * Fails silently if no browser is available (e.g., headless server).
 */
async function tryOpenBrowser(url: string): Promise<boolean> {
  try {
    const { exec } = await import('node:child_process');
    const { platform } = await import('node:os');

    const cmd =
      platform() === 'darwin'
        ? `open "${url}"`
        : platform() === 'win32'
          ? `start "${url}"`
          : `xdg-open "${url}"`;

    exec(cmd);
    return true;
  } catch {
    return false;
  }
}

export async function loginCommand(): Promise<void> {
  const config = loadConfig();

  // Check if already logged in
  if (config.githubToken && config.githubLogin) {
    tui.log.info(`ℹ️  Already logged in as ${config.githubLogin}.`);
    tui.log.info('   Run "ghagga logout" first to switch accounts.\n');
    return;
  }

  tui.intro('🔐 Authenticating with GitHub');

  try {
    // Step 1: Request device code
    const deviceCode = await requestDeviceCode();

    // Step 2: Show user code and open browser
    tui.log.step('   ➔ Open this URL in your browser:\n');
    tui.log.message(`     https://github.com/login/device\n`);
    tui.log.step(`   ➔ Enter this code:\n`);
    tui.log.message(`     ${deviceCode.user_code}\n`);

    const opened = await tryOpenBrowser(deviceCode.verification_uri);
    if (opened) {
      tui.log.info('   (Browser opened automatically)\n');
    }

    // Step 3: Poll for access token (with spinner)
    const s = tui.spinner();
    s.start('Waiting for authorization...');

    const tokenResponse = await pollForAccessToken(
      deviceCode.device_code,
      deviceCode.interval,
      deviceCode.expires_in,
    );

    s.stop('Authorization received');

    // Step 4: Fetch user profile
    const user = await fetchGitHubUser(tokenResponse.access_token);

    // Step 5: Save to config
    saveConfig({
      ...config,
      githubToken: tokenResponse.access_token,
      githubLogin: user.login,
      defaultProvider: 'gateway',
      defaultModel: 'auto',
    });

    tui.log.success(`\n✅ Logged in as ${user.login}`);
    tui.log.info('   Provider: gateway (auto)');
    tui.outro('Run "ghagga review ." to review your code!');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tui.log.error(`\n❌ Login failed: ${message}\n`);
    process.exit(1);
  }
}
