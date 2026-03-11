document.addEventListener('DOMContentLoaded', () => {
    const role = localStorage.getItem('k10_role') || 'Staff';
    const username = localStorage.getItem('k10_username') || 'User';
    
    // Determine which links to show based on Role
    const isAdmin = role === 'Admin';

    const navHTML = `
    <nav class="bg-gray-800 shadow-md">
        <div class="max-w-[95%] mx-auto px-4">
            <div class="flex justify-between items-center h-16">
                <div class="flex items-center space-x-8">
                    <div class="flex items-center gap-2">
                        <span class="text-white font-black text-xl tracking-wider bg-blue-600 px-2 py-1 rounded">K10</span>
                        <span class="text-gray-300 text-sm font-bold uppercase tracking-widest hidden md:block">System</span>
                    </div>
                    
                    <div class="hidden md:flex space-x-1">
                        <a href="admin-sales.html" class="px-3 py-2 rounded-md text-sm font-bold text-gray-300 hover:bg-gray-700 hover:text-white transition">💳 POS</a>
                        <a href="admin-preorders.html" class="px-3 py-2 rounded-md text-sm font-bold text-gray-300 hover:bg-gray-700 hover:text-white transition">⏳ Preorders</a>
                        <a href="admin-inventory.html" class="px-3 py-2 rounded-md text-sm font-bold text-gray-300 hover:bg-gray-700 hover:text-white transition">📦 Inventory</a>
                        <a href="admin-categories.html" class="px-3 py-2 rounded-md text-sm font-bold text-gray-300 hover:bg-gray-700 hover:text-white transition">📁 Categories</a>
                        <a href="admin-customers.html" class="px-3 py-2 rounded-md text-sm font-bold text-gray-300 hover:bg-gray-700 hover:text-white transition">👥 Customers</a>
                        
                        ${isAdmin ? `
                        <div class="border-l border-gray-600 mx-2 h-6 mt-1.5"></div>
                        <a href="admin-purchase.html" class="px-3 py-2 rounded-md text-sm font-bold text-blue-400 hover:bg-gray-700 hover:text-white transition">🛒 Order Stock</a>
                        <a href="admin-PurchaseHistory.html" class="px-3 py-2 rounded-md text-sm font-bold text-blue-400 hover:bg-gray-700 hover:text-white transition">📜 PO History</a>
                        <a href="admin-suppliers.html" class="px-3 py-2 rounded-md text-sm font-bold text-blue-400 hover:bg-gray-700 hover:text-white transition">🏢 Suppliers</a>
                        ` : ''}
                    </div>
                </div>

                <div class="flex items-center space-x-4">
                    <div class="hidden md:flex flex-col items-end">
                        <span class="text-sm font-bold text-white leading-tight">${username}</span>
                        <span class="text-[10px] font-bold uppercase tracking-wider ${isAdmin ? 'text-red-400' : 'text-blue-400'}">${role}</span>
                    </div>
                    
                    ${isAdmin ? `
                    <a href="admin-staff.html" class="p-2 text-gray-400 hover:text-white transition" title="Manage Staff">
                        ⚙️
                    </a>
                    ` : ''}
                    
                    <button onclick="logout()" class="ml-4 bg-gray-700 hover:bg-red-600 text-white px-4 py-1.5 rounded text-xs font-bold transition">
                        Logout
                    </button>
                </div>
            </div>
        </div>
    </nav>
    `;

    // Insert navbar at the top of the body
    document.body.insertAdjacentHTML('afterbegin', navHTML);

    // Highlight active link
    const currentPage = window.location.pathname.split('/').pop();
    const links = document.querySelectorAll('nav a');
    links.forEach(link => {
        if (link.getAttribute('href') === currentPage) {
            link.classList.remove('text-gray-300', 'text-blue-400');
            link.classList.add('bg-gray-900', 'text-white');
        }
    });
});

function logout() {
    localStorage.removeItem('k10_token');
    localStorage.removeItem('k10_role');
    localStorage.removeItem('k10_username');
    window.location.href = 'admin.html';
}
