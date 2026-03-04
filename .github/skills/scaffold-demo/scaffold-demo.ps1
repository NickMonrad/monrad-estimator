# scaffold-demo.ps1
# Scaffolds a demo environment for the Monrad Estimator app (Windows/PowerShell)
# Run from the repo root: .\.github\skills\scaffold-demo\scaffold-demo.ps1

param(
    [string]$ApiUrl = "http://localhost:3001",
    [string]$DemoEmail = "demo@example.com",
    [string]$DemoPassword = "Demo1234!"
)

Write-Host "🚀 Scaffolding demo environment..." -ForegroundColor Cyan

# Check API is reachable
try {
    $health = Invoke-RestMethod -Uri "$ApiUrl/health" -Method GET -ErrorAction Stop
    Write-Host "✅ API is reachable" -ForegroundColor Green
} catch {
    Write-Error "❌ API not reachable at $ApiUrl. Start the server first."
    exit 1
}

# Register demo user (ignore error if already exists)
try {
    $body = @{ email = $DemoEmail; password = $DemoPassword; name = "Demo User" } | ConvertTo-Json
    Invoke-RestMethod -Uri "$ApiUrl/api/auth/register" -Method POST -Body $body -ContentType "application/json" -ErrorAction SilentlyContinue
    Write-Host "✅ Demo user created: $DemoEmail" -ForegroundColor Green
} catch {
    Write-Host "ℹ️  Demo user may already exist — continuing" -ForegroundColor Yellow
}

# Login to get token
$loginBody = @{ email = $DemoEmail; password = $DemoPassword } | ConvertTo-Json
$loginResponse = Invoke-RestMethod -Uri "$ApiUrl/api/auth/login" -Method POST -Body $loginBody -ContentType "application/json"
$token = $loginResponse.token
$headers = @{ Authorization = "Bearer $token" }
Write-Host "✅ Logged in as $DemoEmail" -ForegroundColor Green

# Create a demo project
$projectBody = @{ name = "Cloud Migration Initiative"; description = "Demo project for migration to Azure" } | ConvertTo-Json
$project = Invoke-RestMethod -Uri "$ApiUrl/api/projects" -Method POST -Body $projectBody -ContentType "application/json" -Headers $headers
$projectId = $project.id
Write-Host "✅ Created project: $($project.name)" -ForegroundColor Green

# Create an epic
$epicBody = @{ name = "Data Platform Uplift"; description = "Modernise data infrastructure" } | ConvertTo-Json
$epic = Invoke-RestMethod -Uri "$ApiUrl/api/projects/$projectId/epics" -Method POST -Body $epicBody -ContentType "application/json" -Headers $headers
Write-Host "✅ Created epic: $($epic.name)" -ForegroundColor Green

Write-Host ""
Write-Host "🎉 Demo environment ready!" -ForegroundColor Cyan
Write-Host "   URL:      http://localhost:5173" -ForegroundColor White
Write-Host "   Email:    $DemoEmail" -ForegroundColor White
Write-Host "   Password: $DemoPassword" -ForegroundColor White
