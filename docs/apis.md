# API Documentation

This document keeps track of the internal API routes created for the Mission Control application, as well as the external APIs those routes consume.

## Internal API Routes

These are the Next.js API routes defined in our application (`/app/api/...`), what they do, and the external data they fetch.

### AI Dashboard
#### AI News
- **Route:** `GET /api/ai`
- **Purpose:** Fetches the latest stories related to "Artificial Intelligence" or "AI".
- **External API Used:** Hacker News Algolia API
  - Endpoint: `https://hn.algolia.com/api/v1/search?query="Artificial Intelligence" OR "AI"&tags=story&hitsPerPage=10`
- **Response Schema:**
  ```typescript
  Array<{
    id: string;             // Hacker News Object ID
    title: string;          // Story Title
    url: string;            // External URL or Fallback HN Link
    source: "Hacker News"; 
    publishedAt: string;    // ISO Date String
    author: string;         // Author Username
  }>
  ```

### Finance Dashboard
#### Finance Data
- **Route:** `GET /api/finance`
- **Purpose:** Fetches current prices for top cryptocurrencies (Bitcoin, Ethereum, Solana), the top 100 list of cryptocurrencies by market cap, and recommended Bitcoin network fees mapping them out for our finance dashboard.
- **External APIs Used:** 
  - CoinGecko API:
    - Top 100: `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h`
    - Simple Prices: `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true`
  - Mempool.space API:
    - Recommended Fees: `https://mempool.space/api/v1/fees/recommended`
- **Response Schema:**
  ```typescript
  {
    top100: Array<{
      id: string;
      name: string;
      symbol: string;
      marketCapRank: number;
      image: string;
      currentPrice: number;
      priceChange24h: number;
      marketCap: number;
    }>;
    prices: {
      bitcoin: { usd: number; usd_24h_change: number; history: Array<{ time: number; price: number }> };
      ethereum: { usd: number };
      solana: { usd: number };
    };
    fees: { fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number; minimumFee: number };
    timestamp: number; // Date.now() representation
  }
  ```

#### Finance History (Chart Data)
- **Route:** `GET /api/finance/history?coin=[coinId]&range=[days]`
- **Purpose:** Retrieves historical market chart data (price, market cap, and volume) for rendering charts.
- **External API Used:** CoinGecko API
  - Endpoint: `https://api.coingecko.com/api/v3/coins/[coin_id]/market_chart?vs_currency=usd&days=[range_in_days]`
- **Response Schema:**
  ```typescript
  {
    history: Array<{
      time: number;  // Timestamp in ms
      price: number; // Target price
    }>
  }
  ```

### Space Dashboard
#### Space News
- **Route:** `GET /api/space`
- **Purpose:** Retrieves the latest articles related to spaceflight and exploration.
- **External API Used:** Spaceflight News API (SNAPI)
  - Endpoint: `https://api.spaceflightnewsapi.net/v4/articles/?limit=50`
- **Response Schema:**
  ```typescript
  // Returns raw SNAPI Results Payload
  Array<{
    id: number;
    title: string;
    url: string;
    image_url: string;
    news_site: string;
    // ...other raw SNAPI fields
  }>
  ```

#### Rocket Launches
- **Route:** `GET /api/launches`
- **Purpose:** Fetches information about the next upcoming rocket launches worldwide.
- **External API Used:** The Space Devs Launch Library 2
  - Endpoint: `https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=10`
- **Response Schema:**
  ```typescript
  // Returns raw Launch Library 2 Results Payload
  Array<{
    id: string;
    name: string;
    net: string; // ISO String Date
    status: { id: number; name: string; abbrev: string };
    launch_service_provider?: { name: string };
    pad?: { name: string; location: { name: string } };
    image: string;
    // ...other raw LL2 fields
  }>
  ```

#### Solar Activity (Planned)
- **Route:** `GET /api/solar`
- **Purpose:** Fetches current solar activity and space weather, such as current X-Ray flux.
- **External API Used:** NOAA Space Weather Prediction Center (SWPC) JSON REST API
- **Expected Response Schema:**
  ```typescript
  {
    status: string;    // e.g. "Normal"
    xray_flux: string; // e.g. "A4.2"
    updated_at: string; // ISO String
  }
  ```

#### Satellites (Planned)
- **Route:** `GET /api/satellites`
- **Purpose:** Retrieves information and active counts for all currently active satellites in Earth-centric orbits, categorizing them by orbit type (LEO, MEO, GEO, SSO) and notable sub-categories (e.g., Starlink).
- **External API Used:** CelesTrak API / Space-Track API / N2YO / UCS Satellite Database
- **Expected Response Schema:**
  ```typescript
  {
    total_active: number;       // e.g. 9000+
    orbits: {
      LEO: number;              // Low Earth Orbit
      MEO: number;              // Medium Earth Orbit
      GEO: number;              // Geosynchronous/Geostationary Orbit
      SSO: number;              // Sun-Synchronous Orbit
      other: number;            // Other Earth-centric orbits
    };
    constellations: {
      starlink: number;         // Specific count for Starlink
    };
    updated_at: string;         // ISO String
  }
  ```

#### Moon
- **Route:** `GET /api/moon`
- **Purpose:** Provides a weekly calendar of the moon's cycles and highlights upcoming global lunar phenomena, such as supermoons or lunar eclipses (taking place all over the world).
- **External API Used:** Internal Calculation (Algorithms) / Hardcoded global events
- **Expected Response Schema:**
  ```typescript
  {
    weekly_cycles: Array<{
      date: string;         // ISO String Date
      phase: string;        // e.g., "Full Moon", "First Quarter"
      illumination: number; // e.g., 98.4 (percentage)
    }>;
    next_phenomenon: {
      type: string;         // e.g., "Lunar Eclipse" or "Supermoon"
      date: string;         // ISO String Date
      description: string;  // Description of the event with global context
    };
    updated_at: string;     // ISO String Date
  }
  ```

---

## Planned / Experimental Routes

*(Any future API integrations should be documented here before moving them into the main list).*

