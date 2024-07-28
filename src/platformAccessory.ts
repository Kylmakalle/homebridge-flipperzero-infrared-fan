import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { ExampleHomebridgePlatform } from './platform.js';
import { SerialPort } from 'serialport';
import { DEBOUNCE_TIME, IR_FILE_PATH, MEDIUM_THRESHOLD, HIGH_THRESHOLD, RECONNECT_INTERVAL } from './settings.js';
import fs from 'fs';

interface AccessoryStateUpdate {
  On?: boolean;
  Speed?: number;
}

interface AccessoryUpdateDebouncer {
  [key: string]: NodeJS.Timeout | undefined;
  On?: NodeJS.Timeout;
  Speed?: NodeJS.Timeout;
}

export class ExamplePlatformAccessory {
  private service: Service;
  private serialPort: SerialPort | null = null;
  private serialPortName: string;
  private irSignals: any;
  private updateDebouncers: AccessoryUpdateDebouncer = {};
  private reconnectInterval: NodeJS.Timeout | null = null;

  private accessoryState: { [key: string]: boolean | number } = {
    On: false,
    Speed: 0,
  };

  private previousState: { [key: string]: boolean | number } = {
    On: false,
    Speed: 0,
  };

  constructor(
    private readonly platform: ExampleHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    serialPortName: string,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Default-Manufacturer')
      .setCharacteristic(this.platform.Characteristic.Model, 'Default-Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    this.service = this.accessory.getService(this.platform.Service.Fan) || this.accessory.addService(this.platform.Service.Fan);
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.exampleDisplayName);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setSpeed.bind(this))
      .onGet(this.getSpeed.bind(this));

    // Initialize SerialPort and parse IR file
    this.irSignals = this.parseIRFile(IR_FILE_PATH);
    this.serialPortName = serialPortName;
    this.initializeSerialPort();

    // Initialize accessory state from context
    if (this.accessory.context.state) {
      this.accessoryState = this.accessory.context.state;
      this.previousState = { ...this.accessoryState };
    }
  }

  // Serial port
  private initializeSerialPort() {
    if (this.serialPort) {
      try {
        this.serialPort.removeAllListeners();
        if (this.serialPort.isOpen) {
          this.serialPort.close();
        }
      } catch (error) {
        this.platform.log.error('Error cleaning up serial port:', error);
      }
    }

    try {
      this.serialPort = new SerialPort(
        { path: this.serialPortName, baudRate: 230400 },
        (err) => {
          if (err) {
            this.platform.log.error('Failed to open serial port:', err.message);
            this.scheduleReconnect();
          } else {
            this.platform.log.info('Serial port opened successfully');
            if (this.reconnectInterval) {
              clearInterval(this.reconnectInterval);
              this.reconnectInterval = null;
            }
          }
        },
      );
    } catch (error) {
      this.platform.log.error('Error creating serial port:', error);
      this.scheduleReconnect();
      return;
    }

    this.serialPort.on('error', (err) => {
      this.platform.log.error('Serial port error:', err.message);
      this.scheduleReconnect();
    });

    this.serialPort.on('close', () => {
      this.platform.log.warn('Serial port closed');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (!this.reconnectInterval) {
      this.reconnectInterval = setInterval(() => {
        this.platform.log.info('Attempting to reconnect to serial port...');
        this.initializeSerialPort();
      }, RECONNECT_INTERVAL);
    }
  }

  // IR signals
  parseIRFile(filePath: string) {
    const content = fs.readFileSync(filePath, 'utf8');
    const signals: any = {};
    let currentSignal: any = null;

    content.split('\n').forEach(line => {
      line = line.trim();
      if (line.startsWith('name:')) {
        if (currentSignal) {
          signals[currentSignal.name] = currentSignal;
        }
        currentSignal = { name: line.split(':')[1].trim() };
      } else if (currentSignal) {
        if (line.startsWith('frequency:')) {
          currentSignal.frequency = parseInt(line.split(':')[1]);
        } else if (line.startsWith('duty_cycle:')) {
          currentSignal.dutyCycle = parseFloat(line.split(':')[1]) * 100;
        } else if (line.startsWith('data:')) {
          currentSignal.data = line.split(':')[1].trim().split(' ').map(Number);
        }
      }
    });

    if (currentSignal) {
      signals[currentSignal.name] = currentSignal;
    }
    return signals;
  }

  async sendIRSignal(signal: any) {
    this.platform.log.debug('Sending IR signal:', signal.name);
    if (!this.serialPort || !this.serialPort.isOpen) {
      this.platform.log.warn('Serial port is not open. Cannot send IR signal.');
      return;
    }
    // Docs says Flipper can handle up to 512 samples of IR data,
    // but there's likely an issue with serial port stripping data.
    // Chunking it to a safe value
    //
    // https://docs.flipper.net/development/cli/#FEjwz
    const chunkSize = 512 / 8;
    const totalChunks = Math.ceil(signal.data.length / chunkSize);
    for (let i = 0; i < signal.data.length; i += chunkSize) {
      const chunk = signal.data.slice(i, i + chunkSize);
      const command = `ir tx RAW F:${signal.frequency} DC:${signal.dutyCycle} ${chunk.join(' ')}\r\n`;
      try {
        await new Promise<void>((resolve, reject) => {
          this.serialPort!.write(command, (err) => {
            if (err) {
              this.platform.log.error('Error writing to serial port:', err.message);
              reject(err);
            } else {
              resolve();
            }
          });
        });
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        const chunkNumber = Math.ceil((i + chunkSize) / chunkSize);
        this.platform.log.error(`Failed to send chunk ${chunkNumber}/${totalChunks} of IR signal ${signal.name}:`, error);
        break;
      }
    }
  }

  private updateState(update: AccessoryStateUpdate) {
    Object.keys(update).forEach(key => {
      // @ts-expect-error dicts are hard in TS
      this.accessoryState[key] = update[key];
      if (this.updateDebouncers[key]) {
        clearTimeout(this.updateDebouncers[key]);
      }
      this.updateDebouncers[key] = setTimeout(() => {
        // Update the accessory context
        this.accessory.context.state = this.accessoryState;
        this.platform.api.updatePlatformAccessories([this.accessory]);

        // Send the IR signal
        this.sendUpdatedState();

        // Update the previous state
        this.previousState = { ...this.accessoryState };
      }, DEBOUNCE_TIME); // ms debounce time
    });
  }

  private sendUpdatedState() {
    if (this.accessoryState.On !== this.previousState.On) {
      if (this.accessoryState.On) {
        // Fan was turned on, send the appropriate speed command

        // @ts-expect-error dicts are hard in TS
        this.sendSpeedCommand(this.accessoryState.Speed);
      } else {
        // Fan was turned off
        this.sendIRSignal(this.irSignals['Fan_off']);
      }
    } else if (this.accessoryState.On && this.accessoryState.Speed !== this.previousState.Speed) {
      // Fan is on and speed has changed

      // @ts-expect-error dicts are hard in TS
      this.sendSpeedCommand(this.accessoryState.Speed);
    }
  }

  private sendSpeedCommand(speed: number) {
    if (speed < MEDIUM_THRESHOLD) {
      this.sendIRSignal(this.irSignals['Fan_low']);
    } else if (speed < HIGH_THRESHOLD) {
      this.sendIRSignal(this.irSignals['Fan_med']);
    } else {
      this.sendIRSignal(this.irSignals['Fan_high']);
    }
  }

  async setOn(value: CharacteristicValue) {
    this.platform.log.debug('Set On state ->', value);
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    this.updateState({ On: value as boolean });
  }

  async getOn(): Promise<CharacteristicValue> {
    const isOn = this.accessoryState.On;
    this.platform.log.debug('Get On state ->', isOn);
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return isOn;
  }

  async setSpeed(value: CharacteristicValue) {
    this.platform.log.debug('Set Speed -> ', value);
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    this.updateState({ Speed: value as number });
  }

  async getSpeed(): Promise<CharacteristicValue> {
    const speed = this.accessoryState.Speed;
    this.platform.log.debug('Get Speed -> ', speed);
    if (!this.serialPort || !this.serialPort.isOpen) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return speed;
  }
}