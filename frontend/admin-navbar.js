document.addEventListener("DOMContentLoaded", () => {
    const navbarHTML = `
    <nav class="bg-white shadow-sm mb-8 px-4 py-4 flex justify-between items-center sticky top-0 z-50">
        <div class="flex items-center gap-2">
            <span class="bg-blue-600 text-white font-bold p-1 rounded">K10</span>
            <h1 class="text-xl font-bold text-gray-800">Manager Portal</h1>
        </div>
        <div class="space-x-4 flex items-center">
            <a href="admin.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">Inventory</a>
            <a href="admin-purchase.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">New Order</a>
            <a href="admin-PurchaseHistory.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">History</a>
            <a href="admin-customers.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">Customers</a>
            <a href="admin-sales.html" class="nav-link text-gray-600 hover:text-blue-600 font-medium">POS / Sales</a>
            
            <button id="global-logout-btn" class="text-red-600 font-semibold ml-4 border border-red-200 px-3 py-1 rounded hover:bg-red-50 transition">
                Logout
            </button>
        </div>
    </nav>
    `;

    // 1. Insert the Navbar at the very top of the page
    document.body.insertAdjacentHTML('afterbegin', navbarHTML);

    // 2. Highlight the "Active" Page automatically
    const currentPage = window.location.pathname.split("/").pop() || 'admin.html';
    const links = document.querySelectorAll('.nav-link');
    
    links.forEach(link => {
        // Check if the link matches the current file name
        if (link.getAttribute('href') === currentPage) {
            link.classList.remove('text-gray-600');
            link.classList.add('text-blue-600', 'font-bold', 'border-b-2', 'border-blue-600', 'pb-1');
        }
    });

    // 3. Handle Logout (Centralized logic)
    document.getElementById('global-logout-btn').addEventListener('click', () => {
        if(confirm("Log out of Manager Portal?")) {
            localStorage.removeItem('k10_token');
            window.location.href = 'index.html'; // Or admin.html login screen
        }
    });
});
