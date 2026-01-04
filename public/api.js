/**
 * API Service for Django Backend
 * Base URL: https://django-upstream.apps.introdx.com
 */

const API_BASE = 'https://django-upstream.apps.introdx.com';

const ApiService = {
    // Auth state
    token: localStorage.getItem('auth_token') || null,
    user: JSON.parse(localStorage.getItem('auth_user') || 'null'),

    // ============================================
    // Internal helpers
    // ============================================

    /**
     * Get authorization headers for API requests
     */
    _getHeaders(includeAuth = true) {
        const headers = {
            'Content-Type': 'application/json',
        };
        if (includeAuth && this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        return headers;
    },

    /**
     * Generic API request handler
     */
    async _request(endpoint, options = {}) {
        const url = `${API_BASE}${endpoint}`;
        const config = {
            headers: this._getHeaders(options.includeAuth !== false),
            ...options,
        };
        
        try {
            const response = await fetch(url, config);
            const data = await response.json().catch(() => null);
            
            if (!response.ok) {
                throw {
                    status: response.status,
                    message: data?.detail || data?.message || 'Request failed',
                    data: data
                };
            }
            
            return data;
        } catch (error) {
            if (error.status) throw error;
            throw { status: 0, message: error.message || 'Network error' };
        }
    },

    // ============================================
    // Authentication
    // ============================================

    /**
     * Login user
     * @param {string} username - Username or email
     * @param {string} password - Password
     * @returns {Promise<{key: string, user: object}>}
     */
    async login(username, password) {
        const response = await this._request('/accounts/users/login/', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
            includeAuth: false
        });
        
        // Store auth data
        this.token = response.key;
        this.user = response.user;
        localStorage.setItem('auth_token', response.key);
        localStorage.setItem('auth_user', JSON.stringify(response.user));
        
        return response;
    },

    /**
     * Register new user
     * @param {object} data - Registration data
     * @param {string} data.first_name
     * @param {string} data.last_name
     * @param {string} data.email
     * @param {string} data.username
     * @param {string} data.password
     * @param {string} data.confirm_password
     */
    async register(data) {
        return await this._request('/accounts/users/register/', {
            method: 'POST',
            body: JSON.stringify(data),
            includeAuth: false
        });
    },

    /**
     * Get current authenticated user info
     * @returns {Promise<object>} User data
     */
    async whoami() {
        const user = await this._request('/accounts/users/whoami/');
        this.user = user;
        localStorage.setItem('auth_user', JSON.stringify(user));
        return user;
    },

    /**
     * Logout user (client-side only)
     */
    logout() {
        this.token = null;
        this.user = null;
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_user');
    },

    /**
     * Check if user is authenticated
     * @returns {boolean}
     */
    isAuthenticated() {
        return !!this.token;
    },

    /**
     * Validate session by calling whoami
     * @returns {Promise<boolean>}
     */
    async validateSession() {
        if (!this.token) return false;
        try {
            await this.whoami();
            return true;
        } catch (error) {
            if (error.status === 401 || error.status === 403) {
                this.logout();
            }
            return false;
        }
    },

    /**
     * Change password
     * @param {object} data
     * @param {string} data.current_password
     * @param {string} data.new_password
     * @param {string} data.confirm_new_password
     */
    async changePassword(data) {
        return await this._request('/accounts/users/change_password/', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    /**
     * Change email
     * @param {object} data
     * @param {string} data.current_password
     * @param {string} data.email
     */
    async changeEmail(data) {
        return await this._request('/accounts/users/change_email/', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    // ============================================
    // Users
    // ============================================

    /**
     * Get list of users
     * @param {object} params - Query params (limit, offset, search)
     * @returns {Promise<{count: number, next: string, previous: string, results: array}>}
     */
    async getUsers(params = {}) {
        const query = new URLSearchParams(params).toString();
        const endpoint = `/accounts/users/${query ? '?' + query : ''}`;
        return await this._request(endpoint);
    },

    /**
     * Get user by username
     * @param {string} username
     * @returns {Promise<object>}
     */
    async getUser(username) {
        return await this._request(`/accounts/users/${username}/`);
    },

    /**
     * Update user profile
     * @param {string} username
     * @param {object} data - Fields to update (first_name, last_name, fullname, etc.)
     */
    async updateUser(username, data) {
        const updatedUser = await this._request(`/accounts/users/${username}/`, {
            method: 'PATCH',
            body: JSON.stringify(data)
        });
        
        // Update local user state
        this.user = { ...this.user, ...updatedUser };
        localStorage.setItem('auth_user', JSON.stringify(this.user));
        
        return updatedUser;
    },

    /**
     * Update user profile with avatar (using FormData)
     * @param {string} username
     * @param {FormData} formData - FormData containing avatar file and other fields
     */
    async updateUserWithAvatar(username, formData) {
        const url = `${API_BASE}/accounts/users/${username}/`;
        const headers = {};
        
        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        // Note: Don't set Content-Type for FormData - browser sets it with boundary
        
        try {
            const response = await fetch(url, {
                method: 'PATCH',
                headers: headers,
                body: formData
            });
            
            const data = await response.json().catch(() => null);
            
            if (!response.ok) {
                throw {
                    status: response.status,
                    message: data?.detail || data?.message || 'Upload failed',
                    data: data
                };
            }
            
            // Update local user state
            this.user = { ...this.user, ...data };
            localStorage.setItem('auth_user', JSON.stringify(this.user));
            
            return data;
        } catch (error) {
            if (error.status) throw error;
            throw { status: 0, message: error.message || 'Network error' };
        }
    },

    // ============================================
    // Devices
    // ============================================

    /**
     * Get list of devices
     * @param {object} params - Query params (limit, offset)
     */
    async getDevices(params = {}) {
        const query = new URLSearchParams(params).toString();
        const endpoint = `/accounts/devices/${query ? '?' + query : ''}`;
        return await this._request(endpoint);
    },

    /**
     * Get device by ID
     * @param {number} id
     */
    async getDevice(id) {
        return await this._request(`/accounts/devices/${id}/`);
    },

    // ============================================
    // Meetings
    // ============================================

    /**
     * Get list of meetings
     * @param {object} params - Query params (limit, offset, search, start_at_after, start_at_before)
     * @returns {Promise<{count: number, next: string, previous: string, results: array}>}
     */
    async getMeetings(params = {}) {
        const query = new URLSearchParams(params).toString();
        const endpoint = `/meetings/meets/${query ? '?' + query : ''}`;
        return await this._request(endpoint);
    },

    /**
     * Create a new meeting
     * @param {object} data
     * @param {string} data.name - Meeting name
     * @param {string} data.description - Optional description
     * @param {string} data.start_at - ISO datetime
     * @param {number[]} data.participants - Array of user IDs
     */
    async createMeeting(data) {
        return await this._request('/meetings/meets/', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    /**
     * Get meeting by ID
     * @param {number} id
     * @returns {Promise<object>}
     */
    async getMeeting(id) {
        return await this._request(`/meetings/meets/${id}/`);
    },

    /**
     * Update meeting
     * @param {number} id
     * @param {object} data - Fields to update
     */
    async updateMeeting(id, data) {
        return await this._request(`/meetings/meets/${id}/`, {
            method: 'PATCH',
            body: JSON.stringify(data)
        });
    },

    /**
     * Delete meeting
     * @param {number} id
     */
    async deleteMeeting(id) {
        return await this._request(`/meetings/meets/${id}/`, {
            method: 'DELETE'
        });
    },

    // ============================================
    // Participants
    // ============================================

    /**
     * Get participants for a meeting
     * @param {number} meetingId
     * @returns {Promise<array>} List of participants
     */
    async getParticipants(meetingId) {
        return await this._request(`/meetings/meets/${meetingId}/list_participants/`);
    },

    /**
     * Add participant to a meeting
     * @param {number} meetingId
     * @param {number} userId - User ID to add
     * @returns {Promise<object>} Created participant
     */
    async addParticipant(meetingId, userId) {
        return await this._request(`/meetings/meets/${meetingId}/add_participants/`, {
            method: 'POST',
            body: JSON.stringify({ user: userId })
        });
    },

    /**
     * Remove participant from meeting
     * @param {number} participantId
     */
    async removeParticipant(participantId) {
        return await this._request(`/meetings/participants/${participantId}/`, {
            method: 'DELETE'
        });
    },

    /**
     * Update participant acceptance status
     * @param {number} participantId
     * @param {boolean} accepted - true = attending, false = not attending
     */
    async updateParticipantAcceptance(participantId, accepted) {
        return await this._request(`/meetings/participants/${participantId}/accepted/`, {
            method: 'POST',
            body: JSON.stringify({ accepted })
        });
    },

    /**
     * Search users for adding as participants
     * @param {string} query - Search query
     * @returns {Promise<{results: array}>}
     */
    async searchUsers(query) {
        return await this._request(`/accounts/users/?search=${encodeURIComponent(query)}`);
    }
}

// Export for module systems, also make available globally
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ApiService;
}
window.ApiService = ApiService;
