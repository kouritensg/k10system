<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>K10 Admin - Inventory Management</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 font-sans text-gray-800 pb-20">

    <script src="admin-navbar.js"></script>

    <div id="inventory-list-container" class="max-w-7xl mx-auto px-4 mt-8">
        
        <div class="bg-white p-6 rounded-lg shadow-sm border-l-4 border-blue-600 mb-8 flex flex-col md:flex-row justify-between items-center gap-4">
            <div>
                <h2 class="text-2xl font-bold">📦 Inventory Master List</h2>
                <p class="text-xs text-gray-400 font-bold uppercase tracking-widest">Click any product row to view details</p>
            </div>
            <div class="flex gap-2 w-full md:w-auto">
                <input type="text" id="search-inventory" onkeyup="filterInventory()" placeholder="Search card, box, or ID..." 
                       class="p-2 border rounded shadow-sm w-full md:w-64 outline-none focus:ring-2 focus:ring-blue-500">
                <button onclick="openProductModal()" class="bg-blue-600 text-white font-bold px-4 py-2 rounded shadow hover:bg-blue-700 transition whitespace-nowrap">
                    + Add Product
                </button>
            </div>
        </div>

        <div class="bg-white rounded-lg shadow-sm overflow-hidden min-h-[500px]">
            <table class="w-full text-left border-collapse">
                <thead class="bg-gray-50 border-b text-[10px] uppercase font-bold text-gray-400 tracking-widest">
                    <tr>
                        <th class="p-4">Product Name</th>
                        <th class="p-4">Game / Category</th>
                        <th class="p-4 w-32 text-center">Live Stock</th>
                        <th class="p-4 w-32 text-right">Retail Price</th>
                    </tr>
                </thead>
                <tbody id="inventory-list-body"></tbody>
            </table>
            <div id="loading-state" class="p-12 text-center text-gray-400 font-bold animate-pulse">⏳ Loading inventory data...</div>
            <div id="empty-state" class="p-12 text-center text-gray-400 hidden">No products found matching your search.</div>
        </div>
    </div>

    <div id="inventory-details-view" class="hidden max-w-5xl mx-auto px-4 mt-8 animate-fade-in">
        
        <div class="flex justify-between items-center mb-6">
            <button onclick="hideDetails()" class="bg-white border border-gray-300 hover:bg-gray-100 px-5 py-2 rounded shadow-sm font-bold text-sm transition text-gray-600">
                ← Return to Inventory List
            </button>
            <div class="flex gap-2">
                <button onclick="deleteProduct()" class="bg-red-100 text-red-600 border border-red-200 px-6 py-2 rounded font-bold text-sm shadow-sm hover:bg-red-200 transition">
                    Delete
                </button>
                <button onclick="openProductModal(true)" class="bg-yellow-500 text-white px-6 py-2 rounded font-bold text-sm shadow hover:bg-yellow-600 transition">
                    Edit Product
                </button>
            </div>
        </div>

        <div class="bg-white border border-gray-300 shadow-sm rounded-lg overflow-hidden">
            <div class="grid grid-cols-2 border-b border-gray-300">
                <div class="p-5 border-r border-gray-300">
                    <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-1">Item Name</div>
                    <div class="text-2xl font-bold text-gray-800" id="det-card-name"></div>
                </div>
                <div class="p-5">
                    <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-1">Item IP</div>
                    <div class="text-2xl font-bold text-blue-600" id="det-game-title"></div>
                </div>
            </div>

            <div class="grid grid-cols-4 border-b border-gray-300 bg-gray-50">
                <div class="p-4 border-r border-gray-300">
                    <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-1">Total Units</div>
                    <div class="text-xl font-bold text-gray-800" id="det-stock"></div>
                </div>
                <div class="p-4 border-r border-gray-300">
                    <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-1">Selling Price (Per Unit)</div>
                    <div class="text-xl font-bold text-green-600" id="det-price"></div>
                </div>
                <div class="p-4 border-r border-gray-300">
                    <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-1">Allocated QTY</div>
                    <div class="text-xl font-bold text-orange-500" id="det-allocated"></div>
                </div>
                <div class="p-4">
                    <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-1">Allocation Wave</div>
                    <div class="text-xl font-bold text-gray-800" id="det-wave"></div>
                </div>
            </div>

            <div class="p-4 border-b border-gray-300">
                <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-1">Inventory ID</div>
                <div class="text-sm font-mono font-bold text-gray-500" id="det-card-id"></div>
            </div>

            <div class="grid grid-cols-3 border-b border-gray-300 bg-gray-50">
                <div class="p-4 border-r border-gray-300">
                    <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-1">Cost Per Unit</div>
                    <div class="text-lg font-bold text-gray-800" id="det-cost-unit"></div>
                </div>
                <div class="p-4 border-r border-gray-300">
                    <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-1">Tax</div>
                    <div class="text-lg font-bold text-gray-800" id="det-tax-info"></div>
                </div>
                <div class="p-4">
                    <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-1">Cost After Tax</div>
                    <div class="text-lg font-bold text-gray-800" id="det-cost-tax"></div>
                </div>
            </div>

            <div class="grid grid-cols-2 border-b border-gray-300">
                <div class="p-5 border-r border-gray-300 flex flex-col justify-center bg-white">
                    <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-1">Shipping Included?</div>
                    <div class="text-lg font-bold text-gray-800" id="det-shipping"></div>
                </div>
                <div class="grid grid-rows-4 bg-white">
                    <div class="p-3 border-b border-gray-300 bg-gray-50 text-[10px] font-bold text-gray-400 uppercase tracking-widest text-center">Packaging Configuration</div>
                    <div class="p-3 border-b border-gray-300 flex justify-between items-center hover:bg-gray-50">
                        <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Base</span>
                        <span class="font-bold text-gray-800 font-mono" id="calc-unit">-</span>
                    </div>
                    <div class="p-3 border-b border-gray-300 flex justify-between items-center hover:bg-gray-50">
                        <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Display (Box)</span>
                        <span class="font-bold text-gray-800 font-mono" id="calc-box">-</span>
                    </div>
                    <div class="p-3 flex justify-between items-center hover:bg-gray-50">
                        <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Master Case</span>
                        <span class="font-bold text-gray-800 font-mono" id="calc-case">-</span>
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-2">
                <div class="p-5 border-r border-gray-300 bg-gray-50">
                    <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-2">Quick Description</div>
                    <div class="text-sm text-gray-700 leading-relaxed min-h-[100px] whitespace-pre-wrap" id="det-quick-desc"></div>
                </div>
                <div class="p-5 bg-gray-50">
                    <div class="text-[10px] text-gray-400 uppercase font-bold tracking-widest mb-2">Long Description</div>
                    <div class="text-sm text-gray-700 leading-relaxed min-h-[100px] whitespace-pre-wrap" id="det-long-desc"></div>
                </div>
            </div>
        </div>
    </div>

    <div id="product-modal" class="fixed inset-0 bg-gray-900 bg-opacity-60 hidden flex items-center justify-center z-[100] p-4">
        <div class="bg-white rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
            <div class="p-6 border-b sticky top-0 bg-white flex justify-between items-center z-10">
                <h3 class="text-xl font-bold text-gray-800" id="modal-title">Add New Product</h3>
                <button onclick="closeProductModal()" class="text-gray-400 hover:text-gray-600 text-2xl font-bold">&times;</button>
            </div>
            
            <div class="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div class="space-y-4 md:col-span-2">
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Item Name *</label>
                            <input type="text" id="frm-name" class="w-full p-2 border rounded font-bold text-gray-800 outline-none focus:border-blue-500">
                        </div>
                        <div>
                            <label class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Item IP (Game) *</label>
                            <input type="text" id="frm-ip" class="w-full p-2 border rounded font-bold text-blue-600 outline-none focus:border-blue-500">
                        </div>
                    </div>
                    <div>
                        <label class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Inventory ID (Set/Barcode)</label>
                        <input type="text" id="frm-id" class="w-full p-2 border rounded font-mono text-gray-600 outline-none focus:border-blue-500">
                    </div>
                </div>

                <div class="space-y-4 border p-4 rounded bg-gray-50">
                    <h4 class="font-bold text-sm text-gray-700 border-b pb-2">Market & Allocation</h4>
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="text-[10px] font-bold text-gray-400 uppercase">Total Units</label>
                            <input type="number" id="frm-stock" class="w-full p-2 border rounded font-bold">
                        </div>
                        <div>
                            <label class="text-[10px] font-bold text-gray-400 uppercase">Selling Price / Unit ($)</label>
                            <input type="number" step="0.01" id="frm-price" class="w-full p-2 border rounded font-bold text-green-600">
                        </div>
                        <div>
                            <label class="text-[10px] font-bold text-gray-400 uppercase">Allocated Qty</label>
                            <input type="number" id="frm-allocated" class="w-full p-2 border rounded font-bold text-orange-500">
                        </div>
                        <div>
                            <label class="text-[10px] font-bold text-gray-400 uppercase">Allocation Wave</label>
                            <input type="text" id="frm-wave" class="w-full p-2 border rounded font-bold">
                        </div>
                    </div>
                </div>

                <div class="space-y-4 border p-4 rounded bg-gray-50">
                    <h4 class="font-bold text-sm text-gray-700 border-b pb-2">Financials & Packaging</h4>
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="text-[10px] font-bold text-gray-400 uppercase">Cost Per Unit ($)</label>
                            <input type="number" step="0.01" id="frm-cost" class="w-full p-2 border rounded font-bold">
                        </div>
                        <div>
                            <label class="text-[10px] font-bold text-gray-400 uppercase">Tax Rate (e.g., 0.09 for 9%)</label>
                            <input type="number" step="0.01" id="frm-tax" class="w-full p-2 border rounded font-bold">
                        </div>
                        <div>
                            <label class="text-[10px] font-bold text-gray-400 uppercase">Units per Display/Box</label>
                            <input type="number" id="frm-packs" class="w-full p-2 border rounded font-bold">
                        </div>
                        <div>
                            <label class="text-[10px] font-bold text-gray-400 uppercase">Boxes per Case</label>
                            <input type="number" id="frm-cases" class="w-full p-2 border rounded font-bold">
                        </div>
                        <div class="col-span-2 flex items-center gap-2 mt-2">
                            <input type="checkbox" id="frm-shipping" class="w-4 h-4 text-blue-600">
                            <label class="text-sm font-bold text-gray-700">Shipping Included in Cost?</label>
                        </div>
                    </div>
                </div>

                <div class="space-y-4 md:col-span-2">
                    <div>
                        <label class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Quick Description</label>
                        <input type="text" id="frm-quick-desc" class="w-full p-2 border rounded text-gray-700 outline-none focus:border-blue-500">
                    </div>
                    <div>
                        <label class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Long Description</label>
                        <textarea id="frm-long-desc" rows="3" class="w-full p-2 border rounded text-gray-700 outline-none focus:border-blue-500"></textarea>
                    </div>
                </div>
            </div>

            <div class="p-6 border-t bg-gray-50 flex justify-end gap-3 sticky bottom-0 rounded-b-lg">
                <button onclick="closeProductModal()" class="px-6 py-2 rounded font-bold text-gray-500 hover:bg-gray-200 transition">Cancel</button>
                <button onclick="saveProduct()" id="btn-save-product" class="bg-blue-600 text-white px-8 py-2 rounded font-bold shadow hover:bg-blue-700 transition">Save Product</button>
            </div>
        </div>
    </div>

    <script>
        const API_URL = 'https://k10system.onrender.com/api';
        let globalInventory = [];
        let currentEditingId = null; 

        document.addEventListener('DOMContentLoaded', () => {
            if (!localStorage.getItem('k10_token')) { window.location.href = 'admin.html'; return; }
            loadInventory();
        });

        // ------------------ DATA LOADING ------------------
        async function loadInventory() {
            try {
                const res = await fetch(`${API_URL}/inventory/status`);
                globalInventory = await res.json();
                document.getElementById('loading-state').classList.add('hidden');
                renderInventoryList(globalInventory);
            } catch (error) {
                document.getElementById('loading-state').innerText = "❌ Failed to connect to database.";
            }
        }

        function renderInventoryList(items) {
            const tbody = document.getElementById('inventory-list-body');
            const emptyState = document.getElementById('empty-state');
            
            if (items.length === 0) {
                tbody.innerHTML = '';
                emptyState.classList.remove('hidden');
                return;
            }

            emptyState.classList.add('hidden');
            tbody.innerHTML = items.map(item => `
                <tr class="hover:bg-blue-50 cursor-pointer transition border-b group" onclick="showItemDetails(${item.id})">
                    <td class="p-4">
                        <div class="font-bold text-gray-800 group-hover:text-blue-600 transition">${item.card_name || ''}</div>
                        <div class="text-[10px] text-gray-400 uppercase tracking-wider mt-1">${item.card_id || ''}</div>
                    </td>
                    <td class="p-4"><span class="px-2 py-1 bg-gray-100 text-gray-600 rounded text-xs font-bold">${item.game_title || ''}</span></td>
                    <td class="p-4 text-center"><span class="font-bold ${item.stock_quantity <= 0 ? 'text-red-500' : 'text-blue-600'}">${item.stock_quantity ?? '0'}</span></td>
                    <td class="p-4 text-right font-mono font-bold text-gray-700">${item.price != null ? `$${parseFloat(item.price).toFixed(2)}` : ''}</td>
                </tr>
            `).join('');
        }

        function filterInventory() {
            const query = document.getElementById('search-inventory').value.toLowerCase();
            const filtered = globalInventory.filter(item => 
                (item.card_name && item.card_name.toLowerCase().includes(query)) ||
                (item.game_title && item.game_title.toLowerCase().includes(query)) ||
                (item.card_id && item.card_id.toLowerCase().includes(query))
            );
            renderInventoryList(filtered);
        }

        // ------------------ VIEW DETAILS ------------------
        function showItemDetails(id) {
            const item = globalInventory.find(i => i.id === id);
            if (!item) return;

            currentEditingId = id; 

            document.getElementById('inventory-list-container').classList.add('hidden');
            document.getElementById('inventory-details-view').classList.remove('hidden');

            document.getElementById('det-card-name').innerText = item.card_name || '';
            document.getElementById('det-game-title').innerText = item.game_title || '';
            document.getElementById('det-stock').innerText = item.stock_quantity ?? '';
            document.getElementById('det-price').innerText = item.price != null ? `$${parseFloat(item.price).toFixed(2)}` : '';
            document.getElementById('det-allocated').innerText = item.allocated_qty ?? '';
            document.getElementById('det-wave').innerText = item.allocation_wave || '';
            document.getElementById('det-card-id').innerText = item.card_id || '';

            const unitCost = item.cost_price != null ? parseFloat(item.cost_price) : null;
            const taxRate = item.tax_rate != null ? parseFloat(item.tax_rate) : null;

            document.getElementById('det-cost-unit').innerText = unitCost != null ? `$${unitCost.toFixed(2)}` : '';
            document.getElementById('det-tax-info').innerText = taxRate != null ? `${(taxRate * 100).toFixed(2)}%` : '';
            document.getElementById('det-cost-tax').innerText = (unitCost != null && taxRate != null) ? `$${(unitCost * (1 + taxRate)).toFixed(2)}` : '';

            let shippingText = '';
            if (item.shipping_included === 1 || item.shipping_included === true) shippingText = 'Yes';
            else if (item.shipping_included === 0 || item.shipping_included === false) shippingText = 'No';
            document.getElementById('det-shipping').innerText = shippingText;

            const packs = item.packs_per_box != null ? parseInt(item.packs_per_box) : 1;
            const boxes = item.boxes_per_case != null ? parseInt(item.boxes_per_case) : 1;
            
            document.getElementById('calc-unit').innerText = `1 Base Unit`;
            document.getElementById('calc-box').innerText = `${packs} Units / Box`;
            document.getElementById('calc-case').innerText = `${boxes} Boxes / Case`;

            document.getElementById('det-quick-desc').innerText = item.quick_description || '';
            document.getElementById('det-long-desc').innerText = item.long_description || '';
            
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function hideDetails() {
            currentEditingId = null;
            document.getElementById('inventory-list-container').classList.remove('hidden');
            document.getElementById('inventory-details-view').classList.add('hidden');
            document.getElementById('search-inventory').value = '';
            renderInventoryList(globalInventory);
        }

        // ------------------ CRUD MODAL OPERATIONS ------------------
        function openProductModal(isEdit = false) {
            document.getElementById('product-modal').classList.remove('hidden');
            
            if (isEdit && currentEditingId) {
                document.getElementById('modal-title').innerText = "Edit Product";
                document.getElementById('btn-save-product').innerText = "Update Details";
                document.getElementById('btn-save-product').classList.replace('bg-blue-600', 'bg-yellow-500');
                document.getElementById('btn-save-product').classList.replace('hover:bg-blue-700', 'hover:bg-yellow-600');
                
                const item = globalInventory.find(i => i.id === currentEditingId);
                if(item) {
                    document.getElementById('frm-name').value = item.card_name || '';
                    document.getElementById('frm-ip').value = item.game_title || '';
                    document.getElementById('frm-id').value = item.card_id || '';
                    document.getElementById('frm-stock').value = item.stock_quantity ?? '';
                    document.getElementById('frm-price').value = item.price ?? '';
                    document.getElementById('frm-allocated').value = item.allocated_qty ?? '';
                    document.getElementById('frm-wave').value = item.allocation_wave || '';
                    document.getElementById('frm-cost').value = item.cost_price ?? '';
                    document.getElementById('frm-tax').value = item.tax_rate ?? '';
                    document.getElementById('frm-packs').value = item.packs_per_box ?? '';
                    document.getElementById('frm-cases').value = item.boxes_per_case ?? '';
                    document.getElementById('frm-shipping').checked = item.shipping_included === 1 || item.shipping_included === true;
                    document.getElementById('frm-quick-desc').value = item.quick_description || '';
                    document.getElementById('frm-long-desc').value = item.long_description || '';
                }
            } else {
                currentEditingId = null;
                document.getElementById('modal-title').innerText = "Add New Product";
                document.getElementById('btn-save-product').innerText = "Save Product";
                document.getElementById('btn-save-product').classList.replace('bg-yellow-500', 'bg-blue-600');
                document.getElementById('btn-save-product').classList.replace('hover:bg-yellow-600', 'hover:bg-blue-700');
                
                ['frm-name', 'frm-ip', 'frm-id', 'frm-stock', 'frm-price', 'frm-allocated', 'frm-wave', 'frm-cost', 'frm-tax', 'frm-packs', 'frm-cases', 'frm-quick-desc', 'frm-long-desc'].forEach(id => document.getElementById(id).value = '');
                document.getElementById('frm-shipping').checked = false;
            }
        }

        function closeProductModal() {
            document.getElementById('product-modal').classList.add('hidden');
        }

        async function saveProduct() {
            const btn = document.getElementById('btn-save-product');
            btn.disabled = true;
            btn.innerText = "Saving...";

            const payload = {
                card_name: document.getElementById('frm-name').value,
                game_title: document.getElementById('frm-ip').value,
                card_id: document.getElementById('frm-id').value,
                stock_quantity: parseInt(document.getElementById('frm-stock').value) || 0,
                price: parseFloat(document.getElementById('frm-price').value) || 0,
                allocated_qty: parseInt(document.getElementById('frm-allocated').value) || 0,
                allocation_wave: document.getElementById('frm-wave').value,
                cost_price: parseFloat(document.getElementById('frm-cost').value) || 0,
                tax_rate: parseFloat(document.getElementById('frm-tax').value) || 0,
                packs_per_box: parseInt(document.getElementById('frm-packs').value) || 1,
                boxes_per_case: parseInt(document.getElementById('frm-cases').value) || 1,
                shipping_included: document.getElementById('frm-shipping').checked,
                quick_description: document.getElementById('frm-quick-desc').value,
                long_description: document.getElementById('frm-long-desc').value
            };

            if (!payload.card_name || !payload.game_title) {
                alert("Item Name and Item IP are required!");
                btn.disabled = false;
                btn.innerText = currentEditingId ? "Update Details" : "Save Product";
                return;
            }

            try {
                const method = currentEditingId ? 'PUT' : 'POST';
                const endpoint = currentEditingId ? `${API_URL}/inventory/${currentEditingId}` : `${API_URL}/inventory/add`;
                
                const res = await fetch(endpoint, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (res.ok) {
                    alert(currentEditingId ? "Product updated!" : "Product added!");
                    closeProductModal();
                    if (currentEditingId) hideDetails(); 
                    loadInventory(); 
                } else {
                    const data = await res.json();
                    alert("Error: " + data.error);
                }
            } catch (error) {
                alert("Failed to connect to server.");
            } finally {
                btn.disabled = false;
                btn.innerText = currentEditingId ? "Update Details" : "Save Product";
            }
        }

        async function deleteProduct() {
            if (!currentEditingId) return;
            if (!confirm("Are you sure you want to permanently delete this product? This action cannot be undone.")) return;

            try {
                const res = await fetch(`${API_URL}/inventory/${currentEditingId}`, { method: 'DELETE' });
                if (res.ok) {
                    alert("Product deleted.");
                    hideDetails(); 
                    loadInventory(); 
                } else {
                    const data = await res.json();
                    alert("Error: " + data.error);
                }
            } catch (error) {
                alert("Failed to connect to server.");
            }
        }
    </script>
</body>
</html>
