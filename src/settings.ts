import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'FlipperzeroInfraredFan';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-flipperzero-infrared-fan';

export const DEBOUNCE_TIME = 500; // 0.5 seconds wait between fan speed changes

export const IR_FILE_PATH = path.resolve(__dirname, '..', 'Remote.ir');

export const MEDIUM_THRESHOLD = 50; // Medium speed activates on 50% and above
export const HIGH_THRESHOLD = 75; // High speed activates on 75% and above

export const RECONNECT_INTERVAL = 5000; // Try serial connection each 5 seconds

export const IR_SIGNAL_SEND_TRIES = 2; // Repeat (duplicate) IR single this number of times
