

async function checkLaunch() {
    const url = 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=100';
    console.log(`Fetching from ${url}...`);
    
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'MissionControl/1.0',
            }
        });
        
        if (!res.ok) {
            console.error(`Status: ${res.status}`);
            return;
        }
        
        const data = await res.json();
        const results = data.results || [];
        
        console.log(`Found ${results.length} upcoming launches.`);
        
        const fireflyLaunches = results.filter((l: any) => 
            l.rocket?.configuration?.manufacturer?.name?.toLowerCase().includes('firefly') || 
            l.name?.toLowerCase().includes('firefly') ||
            l.launch_service_provider?.name?.toLowerCase().includes('firefly')
        );
        
        console.log(`\nFound ${fireflyLaunches.length} Firefly launches in upcoming:`);
        fireflyLaunches.forEach((l: any) => {
            console.log(`- Name: ${l.name}`);
            console.log(`  ID: ${l.id}`);
            console.log(`  Status: ${l.status?.name}`);
            console.log(`  NET (Expected): ${l.net}`);
            console.log(`  Window Start: ${l.window_start}`);
            console.log(`  Window End: ${l.window_end}`);
        });

        // Let's also check past launches / all launches to see where it might be
        const url2 = 'https://ll.thespacedevs.com/2.2.0/launch/?limit=10&search=firefly';
        console.log(`\nFetching from ${url2}...`);
        const res2 = await fetch(url2, {
            headers: {
                'User-Agent': 'MissionControl/1.0',
            }
        });
        
        if (res2.ok) {
            const data2 = await res2.json();
            console.log(`\nFound Firefly launches in general search (latest):`);
            (data2.results || []).forEach((l: any) => {
                console.log(`- Name: ${l.name}`);
                console.log(`  Status: ${l.status?.name}`);
                console.log(`  NET: ${l.net}`);
            });
        }
        
    } catch (e) {
        console.error(e);
    }
}

checkLaunch();
