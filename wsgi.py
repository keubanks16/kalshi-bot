"""WSGI entry point for the dashboard (PythonAnywhere, gunicorn, etc).

Local:  flask --app wsgi run   or   python wsgi.py
"""

from kalshi_bot.dashboard import create_app

app = application = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
