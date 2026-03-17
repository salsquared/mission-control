async function checkCache() {
    try {
        const res = await fetch('http://localhost:4101/api/space/launches');
        const data = await res.json();
        
        const firefly = data.filter((l: any) => 
            l.name?.toLowerCase().includes('firefly') ||
            l.rocket?.configuration?.manufacturer?.name?.toLowerCase().includes('firefly')
        );
        
        console.log(`Found ${firefly.length} Firefly launches in local cache:`);
        firefly.forEach((l: any) => {
            console.log(`- ${l.name} | Status: ${l.status?.name} | NET: ${l.net}`);
        });
    } catch (e) {
        console.error(e);
    }
}
checkCache();
