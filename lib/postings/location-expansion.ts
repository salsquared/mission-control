/**
 * Expand a user-typed location chip into a list of substrings to OR-match
 * against `JobPosting.location`. The naive "contains <chip>" the route used
 * to do gives surprising results:
 *
 *   - "Los Angeles" misses "Long Beach, CA" (same metro, different city name)
 *   - "United States" misses "Long Beach, CA" (no literal "United States")
 *   - "California" misses "Long Beach, CA" (state code, not name)
 *
 * This table handles the three high-value cases:
 *
 *   1. Metro lookups — "Los Angeles" expands to the ~15 nearest cities
 *      typically found within ~50mi (Long Beach, Pasadena, Burbank, etc.)
 *   2. Country lookups — "United States" expands to ", AL" / ", AK" / ...
 *      since postings consistently use "City, ST" format. " AK" without
 *      the comma would false-positive on things like "Berkeley" → " BE",
 *      so the leading ", " anchor is load-bearing.
 *   3. US state names — "California" expands to ", CA" plus the literal,
 *      so both "California" prose and "Anywhere, CA" postings match.
 *
 * Unknown chips fall through to literal substring match. SQLite's LIKE is
 * ASCII-case-insensitive by default, so no per-needle casing needed.
 *
 * Edits to this file don't need a DB migration — expansion happens at query
 * time. To add a metro or country, drop a new entry in the corresponding
 * Record below and add a smoke-test assertion in location-expansion-smoke.ts.
 */

// US state codes, alphabetical. Used by both the country expansion (so
// "United States" matches ", CA" / ", NY" / ...) and the state-name table.
const US_STATE_CODES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC",
] as const;

const US_STATE_CODE_NEEDLES = US_STATE_CODES.map(c => `, ${c}`);

// US state full names → 2-letter code. Lowercase for case-insensitive lookup.
const US_STATE_NAMES: Record<string, string> = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI",
    "south carolina": "SC", "south dakota": "SD", "tennessee": "TN",
    "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA",
    "washington state": "WA", // disambiguate from Washington DC below
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
    "district of columbia": "DC",
    // NY is special-cased in the metro table below since "New York" most
    // commonly means the city/metro, not the state.
};

// Major metros, lowercase key → list of city/region needles to substring-
// match. Curated to ~50mi radius around the canonical city. Errs toward
// inclusion (false-positives are far less annoying than missing your home
// town). Cities that are unambiguous show up bare ("Pasadena"); cities
// shared across states get qualified ("Hollywood, CA" not "Hollywood").
const METROS: Record<string, string[]> = {
    "los angeles": [
        "Los Angeles", "Long Beach", "Anaheim", "Pasadena", "Burbank",
        "Glendale, CA", "Santa Monica", "Beverly Hills", "Hollywood, CA",
        "Culver City", "Manhattan Beach", "Redondo Beach", "El Segundo",
        "Torrance", "Inglewood", "Westwood", "Hawthorne, CA",
        "Irvine", "Costa Mesa", "Huntington Beach", "Newport Beach",
        "Fullerton", "Orange, CA", "Santa Ana",
    ],
    "la": [/* alias filled in below */],
    "new york": [
        "New York", "NYC", "Manhattan", "Brooklyn", "Queens", "Bronx",
        "Staten Island", "Jersey City", "Newark", "Hoboken", "Yonkers",
        "Long Island City", "Brooklyn, NY", "Stamford",
    ],
    "nyc": [/* alias */],
    "new york city": [/* alias */],
    "san francisco": [
        "San Francisco", "Oakland", "Berkeley", "San Jose", "Palo Alto",
        "Mountain View", "Sunnyvale", "Cupertino", "Menlo Park",
        "Redwood City", "Santa Clara", "Fremont", "San Mateo", "Daly City",
        "South San Francisco", "Burlingame", "Foster City", "Hayward",
        "San Bruno", "Brisbane, CA",
    ],
    "bay area": [/* alias of san francisco — same metro */],
    "sf bay area": [/* alias */],
    "san jose": [/* alias — south bay subset, but treat as full bay area */],
    "silicon valley": [/* alias */],
    "seattle": [
        "Seattle", "Bellevue", "Redmond", "Kirkland", "Bothell",
        "Issaquah", "Renton", "Tukwila", "Lynnwood", "Sammamish",
    ],
    "boston": [
        "Boston", "Cambridge", "Somerville", "Brookline", "Newton",
        "Quincy", "Watertown", "Waltham", "Burlington, MA",
    ],
    "washington dc": [
        "Washington, DC", "Washington DC", "Arlington, VA", "Alexandria, VA",
        "Bethesda", "Reston", "Tysons", "Falls Church", "McLean",
        "Silver Spring", "Rockville", "Vienna, VA",
    ],
    "washington d.c.": [/* alias */],
    "dc": [/* alias */],
    "austin": [
        "Austin", "Round Rock", "Cedar Park", "Pflugerville",
    ],
    "chicago": [
        "Chicago", "Evanston", "Naperville", "Schaumburg", "Oak Park",
        "Skokie", "Aurora, IL",
    ],
    "denver": [
        "Denver", "Boulder", "Aurora, CO", "Lakewood, CO", "Englewood",
        "Westminster, CO", "Centennial",
    ],
    "atlanta": [
        "Atlanta", "Marietta", "Alpharetta", "Decatur", "Sandy Springs",
        "Roswell, GA",
    ],
    "houston": [
        "Houston", "Sugar Land", "The Woodlands", "Katy", "Spring, TX",
    ],
    "dallas": [
        "Dallas", "Plano", "Frisco", "Fort Worth", "Irving", "Arlington, TX",
        "Richardson", "McKinney",
    ],
    "san diego": [
        "San Diego", "Carlsbad", "La Jolla", "Chula Vista", "El Cajon",
        "Oceanside", "Encinitas",
    ],
    "miami": [
        "Miami", "Fort Lauderdale", "Hollywood, FL", "Coral Gables",
        "Doral", "Aventura",
    ],
    "phoenix": [
        "Phoenix", "Scottsdale", "Tempe", "Mesa", "Chandler", "Gilbert",
        "Glendale, AZ",
    ],
    "philadelphia": [
        "Philadelphia", "King of Prussia", "Wilmington, DE",
    ],
    "minneapolis": [
        "Minneapolis", "Saint Paul", "St. Paul", "Bloomington, MN",
        "Eden Prairie",
    ],
    "portland": [
        "Portland, OR", "Beaverton", "Hillsboro, OR",
    ],
    "auckland": ["Auckland"],
    "london": ["London"],
    "berlin": ["Berlin"],
    "paris": ["Paris"],
    "tokyo": ["Tokyo"],
    "singapore": ["Singapore"],
    "tel aviv": ["Tel Aviv"],
    "toronto": ["Toronto"],
    "vancouver": ["Vancouver"],
};

// Wire up aliases — duplicated reference list, so the smoke can verify they
// stay in sync. Mutating the same array reference would be tempting but
// harder to test; keep them explicit.
METROS["la"] = METROS["los angeles"];
METROS["nyc"] = METROS["new york"];
METROS["new york city"] = METROS["new york"];
METROS["bay area"] = METROS["san francisco"];
METROS["sf bay area"] = METROS["san francisco"];
METROS["san jose"] = METROS["san francisco"];
METROS["silicon valley"] = METROS["san francisco"];
METROS["washington d.c."] = METROS["washington dc"];
METROS["dc"] = METROS["washington dc"];

// Country / region names → needles. For the US, we lean on state-code
// suffixes because postings use "City, ST" format consistently. For other
// countries, the literal name + 2-letter code suffix usually suffices.
const COUNTRIES: Record<string, string[]> = {
    "united states": ["United States", "USA", "U.S.A.", ...US_STATE_CODE_NEEDLES],
    "usa": ["United States", "USA", "U.S.A.", ...US_STATE_CODE_NEEDLES],
    "u.s.a.": ["United States", "USA", "U.S.A.", ...US_STATE_CODE_NEEDLES],
    "u.s.": ["United States", "USA", "U.S.A.", ...US_STATE_CODE_NEEDLES],
    // "us" alone is too short — would match "Houston" / "United Kingdom".
    // Users typing "US" can type "USA" instead.
    "united kingdom": ["United Kingdom", "UK", ", UK", "London", "Manchester",
        "Bristol", "Edinburgh", "Cambridge, UK", "Oxford, UK", "Leeds", "Glasgow"],
    "uk": ["United Kingdom", ", UK", "London", "Manchester", "Bristol",
        "Edinburgh", "Cambridge, UK", "Oxford, UK"],
    "canada": ["Canada", ", ON", ", BC", ", QC", ", AB", ", NS", ", MB", ", SK", ", NB",
        "Toronto", "Vancouver", "Montreal", "Ottawa", "Calgary", "Edmonton"],
    "germany": ["Germany", "Berlin", "Munich", "Hamburg", "Frankfurt", "Cologne",
        "Düsseldorf", "Stuttgart"],
    "france": ["France", "Paris", "Lyon", "Marseille", "Toulouse"],
    "australia": ["Australia", "Sydney", "Melbourne", "Brisbane", "Perth"],
    "new zealand": ["New Zealand", ", NZ", "Auckland", "Wellington", "Christchurch"],
    "netherlands": ["Netherlands", "Amsterdam", "Rotterdam", "The Hague", "Utrecht"],
    "ireland": ["Ireland", "Dublin", "Cork", "Galway"],
    "japan": ["Japan", "Tokyo", "Osaka", "Kyoto"],
    "singapore": ["Singapore"],
    "india": ["India", "Bangalore", "Bengaluru", "Mumbai", "Delhi", "Hyderabad",
        "Pune", "Chennai", "Gurgaon", "Noida"],
    "israel": ["Israel", "Tel Aviv", "Jerusalem", "Haifa"],
    "switzerland": ["Switzerland", "Zürich", "Zurich", "Geneva", "Basel"],
    "sweden": ["Sweden", "Stockholm", "Gothenburg", "Malmö"],
    "spain": ["Spain", "Madrid", "Barcelona"],
    "italy": ["Italy", "Milan", "Rome"],
    "poland": ["Poland", "Warsaw", "Kraków", "Krakow", "Wrocław", "Wroclaw", "Gdańsk"],
    "brazil": ["Brazil", "São Paulo", "Sao Paulo", "Rio de Janeiro"],
    "mexico": ["Mexico", "Mexico City", "Guadalajara", "Monterrey"],
};

/**
 * Expand one user-typed location chip into the substrings to OR-match.
 * Unknown chips return `[input]` so the literal substring still works.
 */
export function expandLocationFilter(input: string): string[] {
    const trimmed = input.trim();
    if (!trimmed) return [];
    const norm = trimmed.toLowerCase();

    // Metros take precedence — "Los Angeles" should expand to the metro
    // list, not literal "Los Angeles" alone.
    if (METROS[norm]) return [...METROS[norm]];

    if (COUNTRIES[norm]) return [...COUNTRIES[norm]];

    if (US_STATE_NAMES[norm]) {
        const code = US_STATE_NAMES[norm];
        // Keep the literal too so prose-form "California" postings match.
        return [trimmed, `, ${code}`];
    }

    return [trimmed];
}

/** Convenience: expand each chip and flatten. Order is preserved per-chip
 *  (useful for predictable test fixtures), and the result is deduped. */
export function expandLocationFilters(chips: ReadonlyArray<string>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const chip of chips) {
        for (const needle of expandLocationFilter(chip)) {
            const key = needle.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(needle);
        }
    }
    return out;
}
