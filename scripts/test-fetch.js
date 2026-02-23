/**
 * This script tests fetching satellite data from Celestrak.
 * It makes a request to the Celestrak GP (General Perturbations) API to retrieve 
 * JSON data for all active satellites, then logs the total count and a sample entry.
 */
fetch("https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json")
    .then(res => res.json())
    .then(data => {
        console.log("Total:", data.length);
        console.log("Sample:", data[0]);
    })
    .catch(console.error);
