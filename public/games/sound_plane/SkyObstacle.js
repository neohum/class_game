class SkyObstacle {
    constructor(canvasWidth, canvasHeight) {
        this.type = 'cloud';
        this.width = Math.random() * 80 + 120;
        this.height = Math.random() * 60 + 60;
        this.x = canvasWidth;
        this.y = Math.random() * (canvasHeight - this.height - 40) + 20;
        this.passed = false;
    }

    update(speed) {
        this.x -= speed;
    }

    checkCollision(planeCenterX, planeTopY, planeBottomY, planeLeftX, planeRightX) {
        let cLeft = this.x + 10;
        let cRight = this.x + this.width - 10;
        let cTop = this.y + 10;
        let cBottom = this.y + this.height - 10;

        if (planeRightX > cLeft && planeLeftX < cRight &&
            planeBottomY > cTop && planeTopY < cBottom) {
            return true;
        }
        return false;
    }

    draw(ctx) {
        ctx.fillStyle = 'rgba(71, 85, 105, 0.85)';
        ctx.beginPath();
        ctx.arc(this.x + this.width * 0.3, this.y + this.height * 0.5, this.height * 0.4, 0, Math.PI * 2);
        ctx.arc(this.x + this.width * 0.7, this.y + this.height * 0.5, this.height * 0.4, 0, Math.PI * 2);
        ctx.arc(this.x + this.width * 0.5, this.y + this.height * 0.3, this.height * 0.5, 0, Math.PI * 2);
        ctx.arc(this.x + this.width * 0.5, this.y + this.height * 0.7, this.height * 0.3, 0, Math.PI * 2);
        ctx.fill();
        
        if (Math.random() < 0.1) {
            ctx.strokeStyle = '#facc15';
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(this.x + this.width / 2, this.y + this.height * 0.8);
            ctx.lineTo(this.x + this.width / 2 - 10, this.y + this.height * 0.8 + 15);
            ctx.lineTo(this.x + this.width / 2 + 5, this.y + this.height * 0.8 + 15);
            ctx.lineTo(this.x + this.width / 2 - 5, this.y + this.height * 0.8 + 35);
            ctx.stroke();
        }
    }
}
