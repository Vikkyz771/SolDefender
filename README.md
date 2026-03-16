# SolDefender Trading Bot

A high-performance Solana Telegram bot built for memecoins, launchpads, and fast execution. Supports real-time bonding curve autoselling, TP/SL, and multi-wallet management.

## Features

- **Blazing Fast Swaps** via Jupiter Ultra API with MEV protection and optional gasless execution.
- **Launchpad Autoselling**: Monitors bonding curve progress on Pump.fun, Raydium LaunchLab/Bonk.fun, Meteora DBC, and Moonshot. Automatically sells before or at your set threshold.
- **Multi-Wallet Support**: Generate or import multiple wallets, easily switch active wallets, and fund them securely.
- **Advanced TP/SL**: Take profit, stop loss, and trailing stop loss support evaluated in real-time.
- **Robust RPC Round-Robin**: Never hit rate limits. Load up to 100 RPC keys and the bot seamlessly rotates them for all polling and execution.
- **Security Scanner**: Automatic fast checks on contract address (CA) paste, producing a 1–100 risk score based on Authority, Metadata, and Liquidity.
- **Instant Buy Mode**: One-click CA paste execution.

## Prerequisites

- Node.js (v18 or higher)
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- Helius or Alchemy RPC URLs
- [Jupiter Ultra API keys](https://jup.ag/)

## Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/soldefender.git
   cd soldefender
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment:**
   Copy the example environment file and fill in your details:
   ```bash
   cp .env.example .env
   ```
   **CRITICAL**: Generate a secure 64-character hex string for your `ENCRYPTION_KEY`. This secures all wallet private keys stored in the local SQLite database.

4. **Run the bot:**
   ```bash
   # Development mode with hot-reload
   npm run dev

   # Production build
   npm run build
   npm start
   ```

## Security

* Your wallets are stored locally in `data/bot.db` and are encrypted using `aes-256-gcm`. 
* **DO NOT** commit your `.env` or `data/bot.db` files to source control.
* This is a hot-wallet application. Only deposit funds you are actively trading with.

## Usage

Start the bot on Telegram and type `/start`. The interactive menu will guide you through wallet setup, settings configuration, and trading.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
