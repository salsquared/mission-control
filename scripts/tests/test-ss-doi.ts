const doi = "10.1038/s41586-025-09917-9";
const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=title,authors,abstract,citationCount,year,url,externalIds`;

fetch(url)
    .then(res => res.json())
    .then(data => console.log(JSON.stringify(data, null, 2)))
    .catch(err => console.error(err));
