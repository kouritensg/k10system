document.addEventListener("DOMContentLoaded", () => {
    const navbarHTML = `
    <nav class="bg-white shadow-sm mb-8 px-4 py-4 sticky top-0 z-50">
        <div class="flex flex-wrap justify-between items-center gap-4">
            <div class="flex items-center gap-2">
                <span class="bg-blue-600 text-white font-bold p-1 rounded">K10</span>
                <h1 class="text-xl font-bold text-gray-800">Manager Portal</h1>
            </div>

            <div class="flex flex-wrap items-center gap-4 text-sm">
                <a href="admin.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">Dashboard</a>
                <a href="admin-inventory.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">Inventory</a>
                <a href="admin-categories.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">Inv Categories</a>
                
                <div class="h-4 w-px bg-gray-300 mx-1"></div>
                <a href="admin-purchase.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">New Order</a>
                <a href="admin-PurchaseHistory.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">Purchase History</a>
                <a href=" admin-suppliers.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">Suppliers</a>
                
                <div class="h-4 w-px bg-gray-300 mx-1"></div>
                <a href="admin-sales.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">POS</a>
                <a href="admin-preorders.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">Cust-Preorder</a>
                <a href="admin-sales-history.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">Sales Log</a>
                
                <div class="h-4 w-px bg-gray-300 mx-1"></div>
                <a href="admin-customers.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">Customers</a>
                
                <button id="global-logout-btn" class="text-red-600 font-semibold ml-2 border border-red-200 px-3 py-1 rounded hover:bg-red-50 transition">
                    Logout
                </button>
            </div>
        </div>
    </nav>
    `;

    document.body.insertAdjacentHTML('afterbegin', navbarHTML);

    // Highlight Active Link
    const currentPage = window.location.pathname.split("/").pop() || 'admin.html';
    const links = document.querySelectorAll('.nav-link');
    
    links.forEach(link => {
        if (link.getAttribute('href') === currentPage) {
            link.classList.remove('text-gray-600');
            link.classList.add('text-blue-600', 'font-bold', 'border-b-2', 'border-blue-600', 'pb-1');
        }
    });

    // Logout Logic
    const logoutBtn = document.getElementById('global-logout-btn');
    if(logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if(confirm("Log out?")) {
                localStorage.removeItem('k10_token');
                window.location.href = 'index.html';
            }
        });
    }
});
