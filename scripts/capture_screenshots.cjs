const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const modules = [
    'finance', 'hrm', 'inventory', 'projects', 'payroll', 'attendance', 
    'marketing', 'crm-360', 'approvals', 'org-rbac', 'erp-ops', 'marketing-public'
];

async function captureScreenshots() {
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();
    
    // Assuming local dev server is running on port 5174, but since it failed, we might need a different approach.
    // For now, assume we can navigate to localhost:5174
    
    for (const module of modules) {
        try {
            console.log(`Navigating to ${module}...`);
            await page.goto(`http://localhost:5174/${module}`, { waitUntil: 'networkidle2' });
            
            // Try to collapse sidebar
            // This is a placeholder selector
            await page.evaluate(() => {
                const sidebarToggle = document.querySelector('.sidebar-toggle');
                if (sidebarToggle) sidebarToggle.click();
            });
            
            await page.screenshot({ path: path.join(__dirname, `screenshot_${module}.png`), fullPage: true });
            console.log(`Captured ${module}`);
        } catch (error) {
            console.error(`Failed to capture ${module}: ${error.message}`);
        }
    }
    await browser.close();
}

captureScreenshots();
